require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const bodyParser = require('body-parser');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { BrevoClient } = require('@getbrevo/brevo');

const app = express();
const port = process.env.PORT || 3000;

// Ensure images directory exists (important on Railway ephemeral filesystem)
const imagesDir = path.join(__dirname, 'public', 'images');
if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });
const tempOTPStore = new Map();
const bcrypt = require('bcrypt');

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(bodyParser.urlencoded({ extended: true }));

app.use(session({
    secret: process.env.SESSION_SECRET || 'trimas_b2b_secret_key',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 }
}));

// --- Multer: Image Upload to public/images/ ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, path.join(__dirname, 'public', 'images'));
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const base = path.basename(file.originalname, ext)
            .toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9._-]/g, '');
        cb(null, base + ext);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (/\.(jpe?g|png|webp)$/i.test(file.originalname)) cb(null, true);
        else cb(new Error('Hanya file gambar (JPG, PNG, WEBP) yang diizinkan.'));
    }
});

let brevoClient;
try {
    brevoClient = new BrevoClient({ apiKey: process.env.BREVO_API_KEY });
} catch (e) {
    console.error('Brevo init failed:', e.message);
}

async function sendOTPEmail(toEmail, otpCode) {
    if (!brevoClient) throw new Error('Brevo not initialised — check BREVO_API_KEY');
    return brevoClient.transactionalEmails.sendTransacEmail({
        sender: { name: 'PT Trimas Mitra Perkasa', email: process.env.MAIL_USER },
        to: [{ email: toEmail }],
        subject: 'Kode OTP Login Portal B2B',
        htmlContent: `
            <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px;border:1px solid #e5e7eb;border-radius:8px;">
                <h2 style="color:#1e3a5f;margin-bottom:8px;">PT Trimas Mitra Perkasa</h2>
                <p style="color:#374151;">Gunakan kode berikut untuk masuk ke portal B2B Anda:</p>
                <div style="font-size:36px;font-weight:bold;letter-spacing:8px;color:#f97316;text-align:center;padding:24px 0;">
                    ${otpCode}
                </div>
                <p style="color:#6b7280;font-size:13px;">Kode ini berlaku selama <strong>15 menit</strong>. Jangan bagikan kode ini kepada siapapun.</p>
            </div>
        `
    });
}

async function sendPaymentConfirmationEmail(toEmail, { companyName, invoiceNo, orderId, totalFormatted, items }) {
    if (!brevoClient) throw new Error('Brevo not initialised — check BREVO_API_KEY');
    const itemRows = items.map(i => `
        <tr>
            <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:#374151;">${i.Product_Name}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:center;color:#374151;">${i.Quantity}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right;color:#374151;">${new Intl.NumberFormat('id-ID', {style:'currency',currency:'IDR'}).format(i.Selling_Price)}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right;font-weight:600;color:#1e3a5f;">${new Intl.NumberFormat('id-ID', {style:'currency',currency:'IDR'}).format(i.Quantity * i.Selling_Price)}</td>
        </tr>
    `).join('');

    return brevoClient.transactionalEmails.sendTransacEmail({
        sender: { name: 'PT Trimas Mitra Perkasa', email: process.env.MAIL_USER },
        to: [{ email: toEmail }],
        subject: `Konfirmasi Pembayaran — ${invoiceNo}`,
        htmlContent: `
            <div style="font-family:sans-serif;max-width:600px;margin:auto;padding:0;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;">
                <div style="background:linear-gradient(135deg,#0f2d52,#163d6e);padding:28px 32px;">
                    <h2 style="color:#fff;margin:0;font-size:20px;">PT Trimas Mitra Perkasa</h2>
                    <p style="color:rgba(255,255,255,0.6);margin:4px 0 0;font-size:13px;">Konfirmasi Pembayaran Diterima</p>
                </div>
                <div style="padding:28px 32px;background:#fff;">
                    <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:14px 18px;margin-bottom:24px;display:flex;align-items:center;gap:10px;">
                        <span style="color:#16a34a;font-size:20px;">✓</span>
                        <div>
                            <strong style="color:#14532d;">Pembayaran Dikonfirmasi</strong><br>
                            <span style="font-size:13px;color:#15803d;">Terima kasih, ${companyName}. Pembayaran Anda telah kami terima.</span>
                        </div>
                    </div>

                    <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
                        <tr><td style="padding:6px 0;color:#64748b;font-size:13px;">No. Invoice</td><td style="padding:6px 0;font-weight:700;color:#1e3a5f;font-family:monospace;">${invoiceNo}</td></tr>
                        <tr><td style="padding:6px 0;color:#64748b;font-size:13px;">No. Pesanan</td><td style="padding:6px 0;font-weight:600;">REQ-${orderId}</td></tr>
                        <tr><td style="padding:6px 0;color:#64748b;font-size:13px;">Perusahaan</td><td style="padding:6px 0;font-weight:600;">${companyName}</td></tr>
                        <tr><td style="padding:6px 0;color:#64748b;font-size:13px;">Tanggal Bayar</td><td style="padding:6px 0;font-weight:600;">${new Date().toLocaleDateString('id-ID',{day:'2-digit',month:'long',year:'numeric'})}</td></tr>
                    </table>

                    <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;margin-bottom:20px;">
                        <thead>
                            <tr style="background:#f8fafc;">
                                <th style="padding:10px 12px;text-align:left;font-size:12px;color:#64748b;font-weight:600;border-bottom:1px solid #e5e7eb;">PRODUK</th>
                                <th style="padding:10px 12px;text-align:center;font-size:12px;color:#64748b;font-weight:600;border-bottom:1px solid #e5e7eb;">QTY</th>
                                <th style="padding:10px 12px;text-align:right;font-size:12px;color:#64748b;font-weight:600;border-bottom:1px solid #e5e7eb;">HARGA SATUAN</th>
                                <th style="padding:10px 12px;text-align:right;font-size:12px;color:#64748b;font-weight:600;border-bottom:1px solid #e5e7eb;">SUBTOTAL</th>
                            </tr>
                        </thead>
                        <tbody>${itemRows}</tbody>
                        <tfoot>
                            <tr style="background:#0f2d52;">
                                <td colspan="3" style="padding:12px;color:#fff;font-weight:700;font-size:14px;">Total Pembayaran</td>
                                <td style="padding:12px;text-align:right;color:#f9a05a;font-weight:800;font-size:16px;">${totalFormatted}</td>
                            </tr>
                        </tfoot>
                    </table>

                    <p style="color:#64748b;font-size:13px;line-height:1.6;">
                        Tim kami akan segera memproses pesanan Anda. Jika ada pertanyaan, hubungi kami melalui
                        <a href="https://wa.me/6281288821882" style="color:#16a34a;font-weight:600;">WhatsApp</a> atau email
                        <a href="mailto:sales@trimasmitraperkasa.com" style="color:#2a7ab8;">sales@trimasmitraperkasa.com</a>.
                    </p>
                </div>
                <div style="background:#f8fafc;padding:16px 32px;text-align:center;border-top:1px solid #e5e7eb;">
                    <p style="color:#94a3b8;font-size:12px;margin:0;">© ${new Date().getFullYear()} PT Trimas Mitra Perkasa · Batam, Indonesia</p>
                </div>
            </div>
        `
    });
}

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'trimas_db'
});

app.listen(port, () => {
    if (!process.env.SESSION_SECRET) console.warn('WARNING: SESSION_SECRET not set — using insecure default');
    console.log(`Server running at http://localhost:${port}`);
});

// --- Global guard: logged-in customers cannot access any /admin/* route ---
app.use('/admin', (req, res, next) => {
    if (req.session.userEmail && !req.session.adminId) {
        return res.redirect('/dashboard');
    }
    next();
});

// --- ROUTE: Home Page ---
app.get('/', async (req, res) => {
    try {
        const [products] = await pool.query('SELECT * FROM product');
        // We pass the session user to index so the Navbar knows if they are logged in!
        res.render('index', { products: products, user: req.session.user }); 
    } catch (err) {
        console.error(err);
        res.status(500).send("Database Error");
    }
});

app.get('/portal', (req, res) => {
    res.render('portal'); 
});

// --- ROUTE: Request OTP ---
app.post('/request-otp', async (req, res) => {
    const { email } = req.body;
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const expiryTime = new Date(Date.now() + 15 * 60000); 

    try {
        const [users] = await pool.query('SELECT * FROM customer WHERE Email = ?', [email]);
        if (users.length > 0) {
            await pool.query('UPDATE customer SET OTP_Code = ?, OTP_Expiry = ? WHERE Email = ?', [otpCode, expiryTime, email]);
        } else {
            tempOTPStore.set(email, { otpCode: otpCode, expiryTime: expiryTime });
        }
        sendOTPEmail(email, otpCode).catch(err => console.error('Mail error:', err.message));

        // Respond immediately — don't wait for email delivery
        res.render('otp-verify', { email: email });
    } catch (err) {
        console.error(err);
        res.status(500).send("Database Error");
    }
});

// --- ROUTE: Verify OTP ---
app.post('/verify-otp', async (req, res) => {
    const email = req.body.email ? req.body.email.trim() : "";
    const otp_code = req.body.otp_code ? req.body.otp_code.trim() : "";

    try {
        // 1. NEW USER FLOW
        if (tempOTPStore.has(email)) {
            const pending = tempOTPStore.get(email);
            if (String(pending.otpCode) === String(otp_code) && pending.expiryTime > Date.now()) {
                tempOTPStore.delete(email);
                req.session.userEmail = email; // Save to memory!
                return res.render('dashboard', { user: null, isNewUser: true, email: email, pendingRequests: [], activeOrders: [] });
            }
            return res.status(401).send("OTP salah atau kedaluwarsa.");
        }

        // 2. EXISTING USER FLOW
        const [users] = await pool.query('SELECT * FROM customer WHERE Email = ? AND OTP_Code = ? AND OTP_Expiry > NOW()', [email, otp_code]);
        
        if (users.length > 0) {
            await pool.query('UPDATE customer SET OTP_Code = NULL, OTP_Expiry = NULL WHERE Email = ?', [email]);
            req.session.userEmail = email; // Save to memory!
            req.session.user = users[0];   // Save the full user object
            return res.redirect('/dashboard'); // Use redirect so the URL looks clean
        }

        return res.status(401).send("OTP salah atau tidak ditemukan.");
    } catch (err) {
        console.error(err);
        res.status(500).send("Database Error");
    }
});

// --- ROUTE: Complete Onboarding (With Composite Name Splitting) ---
app.post('/complete-onboarding', async (req, res) => {
    // 1. Grab full_name instead of f_name
    const { email, company_name, full_name, phone } = req.body;

    // 2. COMPOSITE ATTRIBUTE SPLITTER LOGIC
    let f_name = "";
    let l_name = null; // Default to null if they only enter one word
    
    // Trim accidental spaces and split by any amount of whitespace
    const nameParts = full_name.trim().split(/\s+/); 

    if (nameParts.length === 1) {
        // Scenario A: 1 Word (e.g., "Daniel")
        f_name = nameParts[0];
    } 
    else if (nameParts.length === 2) {
        // Scenario B: 2 Words (e.g., "Daniel Lim") -> Splits normally
        f_name = nameParts[0];
        l_name = nameParts[1];
    } 
    else if (nameParts.length >= 3) {
        // Scenario C: 3+ Words (e.g., "Daniel Alexander Lim")
        // "take the front initial and last name only"
        
        // Gets the first letter of the first word and adds a period (e.g., "D.")
        f_name = nameParts[0].charAt(0).toUpperCase() + "."; 
        
        // Gets the very last word in the array (e.g., "Lim")
        l_name = nameParts[nameParts.length - 1]; 
        
        /* Note: If you meant "First Name + Middle Initial" (e.g., "Daniel A."), 
           change f_name to: nameParts[0] + " " + nameParts[1].charAt(0).toUpperCase() + "."; 
        */
    }

    try {
        // Check if customer already exists (duplicate email from failed previous attempt)
        const [existing] = await pool.query('SELECT * FROM customer WHERE Email = ?', [email]);

        let custId;
        if (existing.length > 0) {
            // Update existing record instead of inserting
            custId = existing[0].Cust_ID;
            await pool.query(
                'UPDATE customer SET Company_Name=?, F_name=?, L_name=? WHERE Cust_ID=?',
                [company_name, f_name, l_name, custId]
            );
        } else {
            const [result] = await pool.query(
                'INSERT INTO customer (Company_Name, F_name, L_name, Email) VALUES (?, ?, ?, ?)',
                [company_name, f_name, l_name, email]
            );
            custId = result.insertId;
        }

        // Save phone (ignore duplicate)
        await pool.query(
            'INSERT INTO customer_phone (Cust_ID, Phone_Number) VALUES (?, ?) ON DUPLICATE KEY UPDATE Phone_Number=VALUES(Phone_Number)',
            [custId, phone]
        );

        // Fetch fresh user and update session
        const [users] = await pool.query('SELECT * FROM customer WHERE Email = ?', [email]);
        req.session.user = users[0];

        res.redirect('/dashboard');
    } catch (err) {
        console.error(err);
        res.status(500).send("Database Error");
    }
});

// --- ROUTE: Dashboard (Protected by Session) ---
app.get('/dashboard', async (req, res) => {
    // SECURITY CHECK: If they don't have a session, kick them back to login
    if (!req.session.userEmail) {
        return res.redirect('/portal'); 
    }

    try {
        const [users] = await pool.query('SELECT * FROM customer WHERE Email = ?', [req.session.userEmail]);
        
        res.render('dashboard', { 
            user: users[0], 
            pendingRequests: [], // Mock data so it doesn't crash
            activeOrders: []     // Mock data so it doesn't crash
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Database Error");
    }
}); 
// --- ROUTE: Dashboard - E-Katalog Produk ---
app.get('/dashboard/products', async (req, res) => {
    // SECURITY CHECK: Kick them out if they aren't logged in
    if (!req.session.userEmail) {
        return res.redirect('/portal'); 
    }

    try {
        // 1. Get the current user
        const [users] = await pool.query('SELECT * FROM customer WHERE Email = ?', [req.session.userEmail]);
        
        // 2. Fetch all products from your 3NF Database
        const [products] = await pool.query('SELECT * FROM product');

        // 3. Render the new page, passing user, products, and cart
        res.render('dashboard-products', {
            user: users[0],
            products: products,
            cart: req.session.cart || []
        });

    } catch (err) {
        console.error(err);
        res.status(500).send("Database Error");
    }
});

// --- ROUTE: Product Detail Page ---
app.get('/dashboard/products/:id', async (req, res) => {
    if (!req.session.userEmail) return res.redirect('/portal');

    try {
        const [users] = await pool.query('SELECT * FROM customer WHERE Email = ?', [req.session.userEmail]);
        const [products] = await pool.query('SELECT * FROM product WHERE Product_ID = ?', [req.params.id]);

        if (!products.length) return res.redirect('/dashboard/products');

        const [specs] = await pool.query('SELECT * FROM spec_item WHERE Product_ID = ?', [req.params.id]);
        const [features] = await pool.query('SELECT * FROM product_feature WHERE Product_ID = ?', [req.params.id]);
        const [applications] = await pool.query('SELECT * FROM product_application WHERE Product_ID = ?', [req.params.id]);

        res.render('dashboard-product-detail', {
            user: users[0],
            product: products[0],
            specs: specs,
            features: features,
            applications: applications,
            cart: req.session.cart || []
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Database Error");
    }
});

// --- ROUTE: Order Detail (Customer) ---
app.get('/dashboard/history/:id', async (req, res) => {
    if (!req.session.userEmail) return res.redirect('/portal');

    try {
        const [users] = await pool.query('SELECT * FROM customer WHERE Email = ?', [req.session.userEmail]);
        const [orders] = await pool.query(
            'SELECT * FROM sales_order WHERE Order_ID = ? AND Cust_ID = ?',
            [req.params.id, users[0].Cust_ID]
        );
        if (!orders.length) return res.redirect('/dashboard/history');

        const [details] = await pool.query(`
            SELECT od.*, p.Product_Name, p.Img_Url
            FROM order_detail od
            JOIN product p ON od.Product_ID = p.Product_ID
            WHERE od.Order_ID = ?
        `, [req.params.id]);

        const total = details.reduce((sum, d) => sum + (d.Quantity * d.Selling_Price), 0);
        const totalFormatted = total > 0
            ? new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR' }).format(total)
            : 'Menunggu Penawaran';

        res.render('dashboard-order-detail', {
            user: users[0],
            cart: req.session.cart || [],
            order: orders[0],
            details,
            totalFormatted
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Database Error");
    }
});

// --- ROUTE: Transaction History ---
// --- ROUTE: Transaction History (REAL DATABASE QUERY) ---
app.get('/dashboard/history', async (req, res) => {
    if (!req.session.userEmail) return res.redirect('/portal');

    try {
        // 1. Get the current user
        const [users] = await pool.query('SELECT * FROM customer WHERE Email = ?', [req.session.userEmail]);
        const user = users[0];

        const [dbHistory] = await pool.query(`
            SELECT
                o.Order_ID AS id,
                DATE_FORMAT(o.Order_Date, '%d %b %Y') AS date,
                o.Order_Status AS status,
                COUNT(od.Product_ID) AS items,
                SUM(od.Quantity * od.Selling_Price) AS raw_total
            FROM sales_order o
            LEFT JOIN order_detail od ON o.Order_ID = od.Order_ID
            WHERE o.Cust_ID = ?
            GROUP BY o.Order_ID
            ORDER BY o.Order_Date DESC
        `, [user.Cust_ID]);

        const formattedHistory = dbHistory.map(row => {
            let badgeColor = 'warning';
            if (row.status === 'Selesai') badgeColor = 'success';
            if (row.status === 'Dibatalkan') badgeColor = 'danger';
            if (row.status === 'Penawaran Dikirim') badgeColor = 'info';

            const formattedTotal = row.raw_total
                ? new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR' }).format(row.raw_total)
                : 'Menunggu Penawaran';

            return {
                id: `REQ-${row.id}`,
                date: row.date,
                items: row.items,
                total_value: formattedTotal,
                status: row.status,
                color: badgeColor
            };
        });

        res.render('dashboard-history', {
            user: user,
            cart: req.session.cart || [],
            history: formattedHistory
        });

    } catch (err) {
        console.error(err);
        res.status(500).send("Database Error");
    }
});

// --- ROUTE: Submit Final Request (Cart -> Database) ---
app.post('/submit-final-request', async (req, res) => {
    // 1. Cek keamanan: Apakah user login & punya keranjang?
    if (!req.session.userEmail || !req.session.cart || req.session.cart.length === 0) {
        return res.redirect('/dashboard/products');
    }

    // Gunakan connection khusus untuk Transaction (bukan sekadar pool.query)
    const connection = await pool.getConnection();

    try {
        // Ambil Cust_ID dari database berdasarkan email
        const [users] = await connection.query('SELECT Cust_ID FROM customer WHERE Email = ?', [req.session.userEmail]);
        const custId = users[0].Cust_ID;

        // MULAI TRANSACTION DATABASE
        await connection.beginTransaction();

        // 2. Insert ke SALES_ORDER (Tabel Induk)
        const notes = req.body.notes ? req.body.notes.trim() : null;
        const [orderResult] = await connection.query(
            'INSERT INTO sales_order (Cust_ID, Order_Status, Order_Source, Notes) VALUES (?, ?, ?, ?)',
            [custId, 'Pending Review', 'Portal Web', notes]
        );
        
        // Ambil ID pesanan yang baru saja dibuat
        const newOrderId = orderResult.insertId;

        // 3. Loop isi keranjang dan Insert ke ORDER_DETAIL (Tabel Bridge)
        for (const item of req.session.cart) {
            await connection.query(
                'INSERT INTO order_detail (Order_ID, Product_ID, Quantity, Selling_Price) VALUES (?, ?, ?, ?)',
                // Harga kita set 0.00 dulu karena ini masih "Minta Penawaran Harga" (Admin akan update nanti)
                [newOrderId, item.id, item.qty, 0.00] 
            );
        }

        // 4. SIMPAN SEMUA PERUBAHAN SECARA PERMANEN
        await connection.commit();

        // 5. Kosongkan keranjang di memori session
        req.session.cart = [];

        // 6. Lempar user ke halaman Riwayat Transaksi untuk melihat pesanannya
        res.redirect('/dashboard/history');

    } catch (err) {
        // JIKA ADA ERROR, BATALKAN SEMUA INSERT (Mencegah data setengah masuk)
        await connection.rollback();
        console.error("Transaction Error:", err);
        res.status(500).send("Terjadi kesalahan saat memproses pesanan Anda.");
    } finally {
        // Kembalikan koneksi ke Pool
        connection.release();
    }
});

// --- ROUTE: Add Item to Cart (Missing from your code) ---
app.post('/add-to-cart', (req, res) => {
    if (!req.session.userEmail) return res.redirect('/portal');

    const { product_id, product_name } = req.body;

    // Create cart in memory if it doesn't exist yet
    if (!req.session.cart) {
        req.session.cart = [];
    }

    // Push the selected item into the session memory
    req.session.cart.push({ id: product_id, name: product_name, qty: 1 });

    // Send them back to the catalog silently
    res.redirect('/dashboard/products');
});

// --- ROUTE: View the Cart UI ---
app.get('/dashboard/cart', async (req, res) => {
    if (!req.session.userEmail) return res.redirect('/portal');

    try {
        const [users] = await pool.query('SELECT * FROM customer WHERE Email = ?', [req.session.userEmail]);
        const cart = req.session.cart || [];

        // Enrich cart with product images from DB
        let enrichedCart = cart;
        if (cart.length > 0) {
            const ids = cart.map(i => i.id);
            const [products] = await pool.query('SELECT Product_ID, Img_Url FROM product WHERE Product_ID IN (?)', [ids]);
            const imgMap = {};
            products.forEach(p => { imgMap[p.Product_ID] = p.Img_Url; });
            enrichedCart = cart.map(i => ({ ...i, img: imgMap[i.id] || null }));
        }

        res.render('dashboard-cart', { user: users[0], cart: enrichedCart });
    } catch (err) {
        console.error(err);
        res.status(500).send("Database Error");
    }
});

// --- ROUTE: Update Cart Item Qty ---
app.post('/cart/update', (req, res) => {
    if (!req.session.userEmail) return res.redirect('/portal');
    const { product_id, action } = req.body;
    const cart = req.session.cart || [];
    const idx = cart.findIndex(i => String(i.id) === String(product_id));
    if (idx !== -1) {
        if (action === 'increase') cart[idx].qty += 1;
        else if (action === 'decrease') {
            cart[idx].qty -= 1;
            if (cart[idx].qty <= 0) cart.splice(idx, 1);
        } else if (action === 'remove') {
            cart.splice(idx, 1);
        }
    }
    req.session.cart = cart;
    res.redirect('/dashboard/cart');
});

// --- ROUTE: Payment Page ---
app.get('/dashboard/payment/:id', async (req, res) => {
    if (!req.session.userEmail) return res.redirect('/portal');

    try {
        const [users] = await pool.query('SELECT * FROM customer WHERE Email = ?', [req.session.userEmail]);
        const [orders] = await pool.query('SELECT * FROM sales_order WHERE Order_ID = ? AND Cust_ID = ?', [req.params.id, users[0].Cust_ID]);

        if (!orders.length || orders[0].Order_Status !== 'Selesai') return res.redirect('/dashboard/history');

        const [details] = await pool.query(`
            SELECT od.*, p.Product_Name FROM order_detail od
            JOIN product p ON od.Product_ID = p.Product_ID
            WHERE od.Order_ID = ?
        `, [req.params.id]);

        const total = details.reduce((sum, d) => sum + (d.Quantity * d.Selling_Price), 0);
        const totalFormatted = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR' }).format(total);

        const [invoices] = await pool.query('SELECT * FROM invoice WHERE Order_ID = ?', [req.params.id]);
        const invoice = invoices[0] || null;

        res.render('dashboard-payment', { user: users[0], order: orders[0], details, totalFormatted, invoice, paid: req.query.paid });
    } catch (err) {
        console.error(err);
        res.status(500).send("Database Error");
    }
});

// --- ROUTE: Customer Agrees to Quote ---
app.post('/dashboard/history/:id/agree', async (req, res) => {
    if (!req.session.userEmail) return res.redirect('/portal');
    try {
        const [users] = await pool.query('SELECT * FROM customer WHERE Email = ?', [req.session.userEmail]);
        const [orders] = await pool.query(
            "SELECT * FROM sales_order WHERE Order_ID = ? AND Cust_ID = ? AND Order_Status = 'Penawaran Dikirim'",
            [req.params.id, users[0].Cust_ID]
        );
        if (!orders.length) return res.redirect('/dashboard/history');

        await pool.query("UPDATE sales_order SET Order_Status = 'Selesai' WHERE Order_ID = ?", [req.params.id]);

        // Generate invoice
        const invoiceNo = `INV-${new Date().getFullYear()}-${String(req.params.id).padStart(5, '0')}`;
        const dueDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        await pool.query(
            'INSERT INTO invoice (Invoice_No, Due_Date, Payment_Status, Order_ID) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE Invoice_No=Invoice_No',
            [invoiceNo, dueDate, 'Pending', req.params.id]
        );

        res.redirect(`/dashboard/payment/${req.params.id}`);
    } catch (err) {
        console.error(err);
        res.status(500).send("Database Error");
    }
});

// --- ROUTE: Customer Declines Quote ---
app.post('/dashboard/history/:id/decline', async (req, res) => {
    if (!req.session.userEmail) return res.redirect('/portal');
    try {
        const [users] = await pool.query('SELECT * FROM customer WHERE Email = ?', [req.session.userEmail]);
        const [orders] = await pool.query(
            "SELECT * FROM sales_order WHERE Order_ID = ? AND Cust_ID = ? AND Order_Status = 'Penawaran Dikirim'",
            [req.params.id, users[0].Cust_ID]
        );
        if (!orders.length) return res.redirect('/dashboard/history');

        await pool.query("UPDATE sales_order SET Order_Status = 'Dibatalkan' WHERE Order_ID = ?", [req.params.id]);
        res.redirect('/dashboard/history');
    } catch (err) {
        console.error(err);
        res.status(500).send("Database Error");
    }
});

// --- ROUTE: Confirm Payment ---
app.post('/dashboard/payment/:id/confirm', async (req, res) => {
    if (!req.session.userEmail) return res.redirect('/portal');
    try {
        const [users] = await pool.query('SELECT * FROM customer WHERE Email = ?', [req.session.userEmail]);
        const user = users[0];
        const [orders] = await pool.query('SELECT * FROM sales_order WHERE Order_ID = ? AND Cust_ID = ?', [req.params.id, user.Cust_ID]);
        if (!orders.length) return res.redirect('/dashboard/history');

        await pool.query("UPDATE invoice SET Payment_Status = 'Paid' WHERE Order_ID = ?", [req.params.id]);

        // Fetch invoice + order items for email
        const [invoices] = await pool.query('SELECT * FROM invoice WHERE Order_ID = ?', [req.params.id]);
        const [details] = await pool.query(`
            SELECT od.*, p.Product_Name
            FROM order_detail od
            JOIN product p ON od.Product_ID = p.Product_ID
            WHERE od.Order_ID = ?
        `, [req.params.id]);
        const total = details.reduce((sum, d) => sum + (d.Quantity * d.Selling_Price), 0);
        const totalFormatted = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR' }).format(total);

        // Fire email — don't block the redirect
        sendPaymentConfirmationEmail(user.Email, {
            companyName: user.Company_Name || user.F_name,
            invoiceNo: invoices[0]?.Invoice_No || `INV-${new Date().getFullYear()}-${String(req.params.id).padStart(5,'0')}`,
            orderId: req.params.id,
            totalFormatted,
            items: details
        }).catch(err => console.error('Invoice email error:', err.message));

        res.redirect(`/dashboard/payment/${req.params.id}?paid=1`);
    } catch (err) {
        console.error(err);
        res.status(500).send("Database Error");
    }
});

// --- ROUTE: Customer Logout ---
app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/portal');
    });
});

// --- ROUTE: Admin Login Page (obscured URL) ---
const ADMIN_PATH = process.env.ADMIN_PATH || 'admin-login';
app.get(`/${ADMIN_PATH}`, (req, res) => {
    if (req.session.userEmail) return res.redirect('/dashboard');
    if (req.session.adminId) return res.redirect('/admin/dashboard');
    res.render('admin-login', { adminPath: ADMIN_PATH });
});
// Old /admin-login URL returns 404 — not found, no hint it exists
app.get('/admin-login', (req, res) => res.status(404).send('Not Found'));

// --- ROUTE: Process Admin Login ---
app.post(`/${ADMIN_PATH}`, async (req, res) => {
    const { username, password } = req.body;

    try {
        const [admins] = await pool.query('SELECT * FROM admin WHERE Username = ?', [username]);

        if (admins.length > 0) {
            const admin = admins[0];
            
            const match = await bcrypt.compare(password, admin.Password_Hash);

            if (match) {
                req.session.adminId = admin.Admin_ID;
                // Menggabungkan F_name dan L_name dari tabel Anda
                req.session.adminName = admin.F_name + ' ' + admin.L_name; 
                
                return res.redirect('/admin/dashboard'); 
            }
        }
        
        res.status(401).send("Username atau password salah.");
        
    } catch (err) {
        console.error(err);
        res.status(500).send("Database Error");
    }
});


// --- ROUTE: Admin Dashboard ---
app.get('/admin/dashboard', async (req, res) => {
    // PROTEKSI: Tendang kembali ke halaman login jika bukan admin
    if (!req.session.adminId) {
        return res.redirect(`/${ADMIN_PATH}`);
    }

    try {
        // Ambil metrik untuk ringkasan di dashboard
        const [productCount]  = await pool.query('SELECT COUNT(*) as total FROM product');
        const [pendingCount]  = await pool.query("SELECT COUNT(*) as total FROM sales_order WHERE Order_Status = 'Pending Review'");
        const [customerCount] = await pool.query('SELECT COUNT(*) as total FROM customer');

        const [recentOrders] = await pool.query(`
            SELECT o.Order_ID, c.Company_Name, o.Order_Date, o.Order_Status
            FROM sales_order o
            JOIN customer c ON o.Cust_ID = c.Cust_ID
            ORDER BY o.Order_Date DESC LIMIT 8
        `);

        res.render('admin-dashboard', {
            adminName:      req.session.adminName,
            totalProducts:  productCount[0].total,
            pendingOrders:  pendingCount[0].total,
            totalCustomers: customerCount[0].total,
            recentOrders:   recentOrders
        });

    } catch (err) {
        console.error(err);
        res.status(500).send("Database Error");
    }
});

// --- ROUTE: Admin Logout ---
app.get('/admin-logout', (req, res) => {
    req.session.destroy();
    res.redirect(`/${ADMIN_PATH}`);
});

// --- ROUTE: Tampilkan Halaman Tambah Produk ---
app.get('/admin/products/add', (req, res) => {
    if (!req.session.adminId) return res.redirect(`/${ADMIN_PATH}`);
    res.render('admin-product-add', { adminName: req.session.adminName });
});

// --- ROUTE: Proses Simpan Produk Baru (Multi-Table Transaction) ---
app.post('/admin/products/add', (req, res, next) => {
    if (!req.session.adminId) return res.redirect(`/${ADMIN_PATH}`);
    next();
}, upload.single('product_image'), async (req, res) => {
    // 1. Ambil data utama
    const { product_name, short_desc, stock, unit_price } = req.body;
    const img_url = req.file ? req.file.filename : (req.body.img_url || null);
    
    // 2. Ambil data array (Pastikan selalu menjadi array walaupun isinya cuma 1)
    const features = [].concat(req.body.features || []).filter(item => item.trim() !== '');
    const applications = [].concat(req.body.applications || []).filter(item => item.trim() !== '');
    const spec_names = [].concat(req.body.spec_names || []);
    const spec_values = [].concat(req.body.spec_values || []);

    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        // 3. Insert ke tabel PRODUCT (Tabel Utama)
        const [prodResult] = await connection.query(
            'INSERT INTO product (Product_Name, Short_Desc, Stock, Unit_Price, Img_Url) VALUES (?, ?, ?, ?, ?)',
            [product_name, short_desc, stock || 0, unit_price || 0, img_url || 'default-valve.jpeg']
        );
        const newProductId = prodResult.insertId;

        // 4. Insert ke tabel PRODUCT_FEATURE (Looping)
        for (const feature of features) {
            await connection.query(
                'INSERT INTO product_feature (Product_ID, Feature_Desc) VALUES (?, ?)',
                [newProductId, feature]
            );
        }

        // 5. Insert ke tabel PRODUCT_APPLICATION (Looping)
        for (const app of applications) {
            await connection.query(
                'INSERT INTO product_application (Product_ID, Application_Desc) VALUES (?, ?)',
                [newProductId, app]
            );
        }

        // 6. Insert ke tabel SPEC_ITEM (Entity-Attribute-Value Looping)
        for (let i = 0; i < spec_names.length; i++) {
            if (spec_names[i].trim() !== '' && spec_values[i].trim() !== '') {
                await connection.query(
                    'INSERT INTO spec_item (Product_ID, Spec_Name, Spec_Value) VALUES (?, ?, ?)',
                    [newProductId, spec_names[i], spec_values[i]]
                );
            }
        }

        // 7. Simpan Permanen!
        await connection.commit();
        res.redirect('/admin/dashboard'); // Bisa diubah ke /admin/products nantinya

    } catch (err) {
        await connection.rollback();
        console.error("Gagal menyimpan produk:", err);
        res.status(500).send("Terjadi kesalahan sistem saat menyimpan produk.");
    } finally {
        connection.release();
    }
});

// --- ROUTE: Halaman Permintaan Penawaran (Admin) ---
app.get('/admin/requests', async (req, res) => {
    if (!req.session.adminId) return res.redirect(`/${ADMIN_PATH}`);

    // 1. Tangkap status filter dari URL (misal: ?status=pending)
    const filterStatus = req.query.status;
    let sqlQuery = `
        SELECT 
            o.Order_ID, 
            c.Company_Name, 
            o.Order_Date, 
            o.Order_Status,
            COUNT(od.Product_ID) AS total_items
        FROM sales_order o
        JOIN customer c ON o.Cust_ID = c.Cust_ID
        LEFT JOIN order_detail od ON o.Order_ID = od.Order_ID
    `;
    
    const queryParams = [];

    // 2. Jika difilter, tambahkan klausa WHERE ke SQL
    if (filterStatus === 'pending') {
        sqlQuery += ` WHERE o.Order_Status = 'Pending Review' `;
    } else if (filterStatus === 'selesai') {
        sqlQuery += ` WHERE o.Order_Status = 'Selesai' `;
    }

    // Lanjutkan dengan GROUP BY dan ORDER BY
    sqlQuery += `
        GROUP BY o.Order_ID, c.Company_Name, o.Order_Date, o.Order_Status
        ORDER BY o.Order_Date DESC
    `;

    try {
        const [requests] = await pool.query(sqlQuery, queryParams);

        const formattedRequests = requests.map(req => {
            let badgeColor = 'secondary';
            if (req.Order_Status === 'Pending Review') badgeColor = 'warning';
            if (req.Order_Status === 'Selesai') badgeColor = 'success';
            if (req.Order_Status === 'Dibatalkan') badgeColor = 'danger';

            return {
                id: req.Order_ID,
                company: req.Company_Name,
                date: new Date(req.Order_Date).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }),
                status: req.Order_Status,
                items: req.total_items,
                color: badgeColor
            };
        });

        // 3. Kirim juga 'currentFilter' ke EJS agar tombol di UI bisa menyala (aktif)
        res.render('admin-requests', { 
            adminName: req.session.adminName,
            requests: formattedRequests,
            currentFilter: filterStatus || 'semua'
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Database Error");
    }
});

// --- ROUTE: Halaman Detail Request & Beri Harga (Admin) ---
app.get('/admin/requests/:id', async (req, res) => {
    if (!req.session.adminId) return res.redirect(`/${ADMIN_PATH}`);
    const orderId = req.params.id;

    try {
        // PERBAIKAN: Mengganti c.Phone_Number menjadi cp.Phone_Number
        const [orders] = await pool.query(`
            SELECT o.*, c.Company_Name, c.F_name, c.Email, cp.Phone_Number 
            FROM sales_order o
            JOIN customer c ON o.Cust_ID = c.Cust_ID
            LEFT JOIN customer_phone cp ON c.Cust_ID = cp.Cust_ID
            WHERE o.Order_ID = ?
        `, [orderId]);

        if (orders.length === 0) return res.status(404).send("Request tidak ditemukan");

        const [details] = await pool.query(`
            SELECT od.*, p.Product_Name, p.Img_Url, p.Unit_Price
            FROM order_detail od
            JOIN product p ON od.Product_ID = p.Product_ID
            WHERE od.Order_ID = ?
        `, [orderId]);

        res.render('admin-request-detail', { 
            adminName: req.session.adminName,
            order: orders[0],
            details: details
        });
    } catch (err) {
        console.error(err);
        // TIPS: Menampilkan pesan error asli ke layar agar mudah dilacak
        res.status(500).send("Database Error");
    }
});
// --- ROUTE: Proses Simpan Harga & Selesaikan Pesanan ---
app.post('/admin/requests/:id/price', async (req, res) => {
    if (!req.session.adminId) return res.redirect(`/${ADMIN_PATH}`);
    
    const orderId = req.params.id;
    // Menangkap array product_id dan array selling_price dari form HTML
    const { product_id, selling_price } = req.body;

    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        // Antisipasi jika form hanya memiliki 1 produk (Express akan membacanya sebagai String tunggal, bukan Array)
        const pIds = [].concat(product_id);
        const prices = [].concat(selling_price);

        // 1. Looping untuk update harga di tabel ORDER_DETAIL
        for (let i = 0; i < pIds.length; i++) {
            // Bersihkan format angka (Hapus titik Rupiah agar jadi angka murni untuk MySQL)
            const cleanPrice = prices[i].replace(/[^0-9]/g, '');
            
            await connection.query(
                'UPDATE order_detail SET Selling_Price = ? WHERE Order_ID = ? AND Product_ID = ?',
                [cleanPrice || 0, orderId, pIds[i]]
            );
        }

        // 2. If admin clicks "Kirim Penawaran", set status to awaiting customer approval
        if (req.body.action === 'finalize') {
            await connection.query(
                "UPDATE sales_order SET Order_Status = 'Penawaran Dikirim' WHERE Order_ID = ?",
                [orderId]
            );
        }

        // 3. Simpan permanen perubahan
        await connection.commit();
        res.redirect('/admin/requests'); 
    } catch (err) {
        await connection.rollback();
        console.error("Gagal update harga:", err);
        res.status(500).send("Terjadi kesalahan sistem saat menyimpan harga.");
    } finally {
        connection.release();
    }
});

// --- ROUTE: Halaman Katalog Produk (Admin) ---
app.get('/admin/products', async (req, res) => {
    // Proteksi halaman admin
    if (!req.session.adminId) return res.redirect(`/${ADMIN_PATH}`);

    try {
        // Ambil semua produk dari database, urutkan dari yang terbaru ditambahkan
        const [products] = await pool.query('SELECT * FROM product ORDER BY Product_ID DESC');

        res.render('admin-products', { 
            adminName: req.session.adminName,
            products: products
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Database Error");
    }
});

// --- ROUTE: Hapus Produk (Admin) ---
app.post('/admin/products/delete/:id', async (req, res) => {
    if (!req.session.adminId) return res.redirect(`/${ADMIN_PATH}`);
    const productId = req.params.id;

    try {
        // PERHATIAN: Karena ada Foreign Key ON DELETE RESTRICT di ORDER_DETAIL, 
        // MySQL otomatis menolak penghapusan jika barang sudah pernah dipesan.
        // Hapus tabel anak dulu (yang tidak dilarang)
        await pool.query('DELETE FROM product_feature WHERE Product_ID = ?', [productId]);
        await pool.query('DELETE FROM product_application WHERE Product_ID = ?', [productId]);
        await pool.query('DELETE FROM spec_item WHERE Product_ID = ?', [productId]);
        
        // Terakhir, hapus produk utama
        await pool.query('DELETE FROM product WHERE Product_ID = ?', [productId]);
        
        res.redirect('/admin/products');
    } catch (err) {
        console.error(err);
        // Jika errornya karena barang sudah ada di histori transaksi:
        if (err.code === 'ER_ROW_IS_REFERENCED_2') {
            return res.status(400).send("Gagal menghapus: Produk ini sudah pernah dipesan oleh pelanggan. Hapus dari riwayat pesanan terlebih dahulu, atau ubah stok menjadi 0.");
        }
        res.status(500).send("Database Error");
    }
});

// --- ROUTE: Halaman Edit Produk (Admin) ---
app.get('/admin/products/edit/:id', async (req, res) => {
    if (!req.session.adminId) return res.redirect(`/${ADMIN_PATH}`);
    const productId = req.params.id;

    try {
        // Ambil data dari ke-4 tabel
        const [products] = await pool.query('SELECT * FROM product WHERE Product_ID = ?', [productId]);
        if (products.length === 0) return res.status(404).send("Produk tidak ditemukan");

        const [features] = await pool.query('SELECT Feature_Desc FROM product_feature WHERE Product_ID = ?', [productId]);
        const [apps] = await pool.query('SELECT Application_Desc FROM product_application WHERE Product_ID = ?', [productId]);
        const [specs] = await pool.query('SELECT Spec_Name, Spec_Value FROM spec_item WHERE Product_ID = ?', [productId]);

        res.render('admin-product-edit', {
            adminName: req.session.adminName,
            product: products[0],
            features: features,
            applications: apps,
            specs: specs
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Database Error");
    }
});

// --- ROUTE: Proses Simpan Edit Produk ---
app.post('/admin/products/edit/:id', (req, res, next) => {
    if (!req.session.adminId) return res.redirect(`/${ADMIN_PATH}`);
    next();
}, upload.single('product_image'), async (req, res) => {
    const productId = req.params.id;
    const { product_name, short_desc, stock, unit_price, existing_img } = req.body;
    const img_url = req.file ? req.file.filename : (existing_img || null);
    
    const features = [].concat(req.body.features || []).filter(item => item.trim() !== '');
    const applications = [].concat(req.body.applications || []).filter(item => item.trim() !== '');
    const spec_names = [].concat(req.body.spec_names || []);
    const spec_values = [].concat(req.body.spec_values || []);

    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        // 1. Update Tabel Utama
        await connection.query(
            'UPDATE product SET Product_Name=?, Short_Desc=?, Stock=?, Unit_Price=?, Img_Url=? WHERE Product_ID=?',
            [product_name, short_desc, stock || 0, unit_price || 0, img_url, productId]
        );

        // 2. Teknik "Sync": Hapus semua anak lama, lalu masukkan yang baru
        await connection.query('DELETE FROM product_feature WHERE Product_ID = ?', [productId]);
        await connection.query('DELETE FROM product_application WHERE Product_ID = ?', [productId]);
        await connection.query('DELETE FROM spec_item WHERE Product_ID = ?', [productId]);

        for (const feature of features) {
            await connection.query('INSERT INTO product_feature (Product_ID, Feature_Desc) VALUES (?, ?)', [productId, feature]);
        }
        for (const app of applications) {
            await connection.query('INSERT INTO product_application (Product_ID, Application_Desc) VALUES (?, ?)', [productId, app]);
        }
        for (let i = 0; i < spec_names.length; i++) {
            if (spec_names[i].trim() !== '' && spec_values[i].trim() !== '') {
                await connection.query('INSERT INTO spec_item (Product_ID, Spec_Name, Spec_Value) VALUES (?, ?, ?)', [productId, spec_names[i], spec_values[i]]);
            }
        }

        await connection.commit();
        res.redirect('/admin/products');
    } catch (err) {
        await connection.rollback();
        console.error("Gagal update produk:", err);
        res.status(500).send("Terjadi kesalahan sistem saat mengupdate produk.");
    } finally {
        connection.release();
    }
});

// --- ROUTE: Halaman Daftar Pelanggan (Admin) ---
app.get('/admin/customers', async (req, res) => {
    // Proteksi keamanan admin
    if (!req.session.adminId) return res.redirect(`/${ADMIN_PATH}`);

    try {
        // Query master: Mengambil data pelanggan, menggabungkan nomor telepon (jika ada lebih dari 1),
        // dan menghitung total transaksi/order yang pernah mereka lakukan.
        const [customers] = await pool.query(`
            SELECT 
                c.Cust_ID, 
                c.Company_Name, 
                CONCAT(c.F_name, ' ', IFNULL(c.L_name, '')) AS PIC_Name, 
                c.Email,
                GROUP_CONCAT(DISTINCT cp.Phone_Number SEPARATOR ', ') AS Phones,
                COUNT(DISTINCT o.Order_ID) AS Total_Orders
            FROM customer c
            LEFT JOIN customer_phone cp ON c.Cust_ID = cp.Cust_ID
            LEFT JOIN sales_order o ON c.Cust_ID = o.Cust_ID
            GROUP BY c.Cust_ID
            ORDER BY c.Cust_ID DESC
        `);

        res.render('admin-customers', { 
            adminName: req.session.adminName,
            customers: customers
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Database Error");
    }
});

