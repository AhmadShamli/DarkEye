const jwt = require('jsonwebtoken');
const db = require('../db');

const SECRET_KEY = process.env.JWT_SECRET || 'darkeye_secret_key_change_me';

const authMiddleware = (req, res, next) => {
    // 1. Check Cookies
    const token = req.cookies?.token || req.headers.authorization?.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const decoded = jwt.verify(token, SECRET_KEY);
        const user = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(decoded.id);
        if (!user) {
            return res.status(401).json({ error: 'Session no longer valid' });
        }
        req.user = user;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid token' });
    }
};

const generateToken = (user) => {
    return jwt.sign(
        { id: user.id, username: user.username, role: user.role },
        SECRET_KEY,
        { expiresIn: '7d' }
    );
};

module.exports = { authMiddleware, generateToken, SECRET_KEY };
