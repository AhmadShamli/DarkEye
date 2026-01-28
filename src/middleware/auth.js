const jwt = require('jsonwebtoken');

const SECRET_KEY = process.env.JWT_SECRET || 'darkeye_secret_key_change_me';

const authMiddleware = (req, res, next) => {
    // 1. Check Cookies
    const token = req.cookies?.token || req.headers.authorization?.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const decoded = jwt.verify(token, SECRET_KEY);
        req.user = decoded;
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
