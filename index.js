#!/usr/bin/env node

const path = require('path');
const cors = require('cors');
const chalk = require('chalk');
const express = require('express');
const buildRouter = require('./routes/build.js');

const app = express();
const port = process.env.PORT || 3000;

app.enable('trust proxy');
app.set('json spaces', 2);

app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use('/api/build', buildRouter);

app.listen(port, () => {
    console.log(chalk.green(`Web2APK running on http://localhost:${port}`));
});

module.exports = app;
