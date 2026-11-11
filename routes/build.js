#!/usr/bin/env node

const crypto = require('crypto');
const multer = require('multer');
const express = require('express');

const router = express.Router();

const { triggerBuild, getBuildStatus, getArtifacts, streamArtifact } = require('../lib/github.js');

const iconCache = new Map();
const ICON_TTL = 60 * 60 * 1000;

const cleanIconCache = () => {
    const now = Date.now();
    for (const [key, val] of iconCache) {
        if (now - val.created > ICON_TTL) iconCache.delete(key);
    }
};

setInterval(cleanIconCache, 10 * 60 * 1000);

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
        cb(null, allowed.includes(file.mimetype));
    }
});

const err = (message) => ({ success: false, message });

router.post('/upload-icon', upload.single('icon'), (req, res) => {
    if (!req.file) return res.json(err('File tidak valid. Gunakan PNG/JPG/WEBP maks 5MB.'));
    cleanIconCache();
    const key = crypto.randomBytes(12).toString('hex');
    iconCache.set(key, {
        buffer: req.file.buffer,
        mimetype: req.file.mimetype,
        created: Date.now()
    });
    const url = `${req.protocol}://${req.get('host')}/api/build/icon/${key}`;
    res.json({ success: true, data: { url } });
});

router.get('/icon/:key', (req, res) => {
    const item = iconCache.get(req.params.key);
    if (!item) return res.status(404).json(err('Icon tidak ditemukan atau sudah expired.'));
    res.setHeader('Content-Type', item.mimetype);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(item.buffer);
});

router.post('/trigger', async (req, res) => {
    try {
        const {
            app_name, package_name, website_url, tagline,
            version_name, version_code, splash_bg, primary_color, icon_url
        } = req.body;

        if (!app_name || !package_name || !website_url || !version_name || !version_code) {
            return res.json(err('Field wajib: app_name, package_name, website_url, version_name, version_code.'));
        }

        const pkgRegex = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,}$/;
        if (!pkgRegex.test(package_name)) {
            return res.json(err('Package name tidak valid. Contoh: com.nama.aplikasi'));
        }

        if (!/^https?:\/\/.+/.test(website_url)) {
            return res.json(err('Website URL harus diawali http:// atau https://'));
        }

        const primaryColor = String(primary_color || '0d9488').replace(/^#/, '');
        const defaultIcon = `https://ui-avatars.com/api/?name=${encodeURIComponent(String(app_name).trim())}&size=192&background=${primaryColor}&color=fff`;

        const inputs = {
            app_name:      String(app_name).trim(),
            package_name:  String(package_name).trim(),
            website_url:   String(website_url).trim(),
            tagline:       String(tagline ?? '').trim(),
            version_name:  String(version_name).trim(),
            version_code:  String(version_code).trim(),
            splash_bg:     String(splash_bg || '0a1628').replace(/^#/, ''),
            primary_color: primaryColor,
            icon_url:      String(icon_url || defaultIcon).trim()
        };

        const result = await triggerBuild(inputs);
        res.json(result);
    } catch (e) {
        res.status(500).json(err(e.message));
    }
});

router.get('/status/:run_id', async (req, res) => {
    try {
        const result = await getBuildStatus(req.params.run_id);
        res.json(result);
    } catch (e) {
        res.status(500).json(err(e.message));
    }
});

router.get('/artifacts/:run_id', async (req, res) => {
    try {
        const result = await getArtifacts(req.params.run_id);
        res.json(result);
    } catch (e) {
        res.status(500).json(err(e.message));
    }
});

router.get('/download/:artifact_id', async (req, res) => {
    try {
        const result = await streamArtifact(req.params.artifact_id, res);
        if (!result.success && !res.headersSent) {
            res.status(500).json(err(result.message));
        }
    } catch (e) {
        if (!res.headersSent) res.status(500).json(err(e.message));
    }
});

module.exports = router;
