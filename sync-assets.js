const fs = require('fs');
const path = require('path');

const rootDir = __dirname;
const wwwDir = path.join(rootDir, 'www');

if (!fs.existsSync(wwwDir)) {
    fs.mkdirSync(wwwDir, { recursive: true });
}

const filesToCopy = [
    'index.html',
    'style.css',
    'data.js',
    'eta.js',
    'driver.js',
    'student.js',
    'admin.js',
    'app.js',
    'manifest.json',
    'sw.js'
];

filesToCopy.forEach(file => {
    const src = path.join(rootDir, file);
    const dest = path.join(wwwDir, file);
    if (fs.existsSync(src)) {
        fs.copyFileSync(src, dest);
        console.log(`Copied: ${file} -> www/`);
    }
});

// Copy icons directory if present
const iconsSrc = path.join(rootDir, 'icons');
const iconsDest = path.join(wwwDir, 'icons');
if (fs.existsSync(iconsSrc)) {
    if (!fs.existsSync(iconsDest)) {
        fs.mkdirSync(iconsDest, { recursive: true });
    }
    fs.readdirSync(iconsSrc).forEach(f => {
        fs.copyFileSync(path.join(iconsSrc, f), path.join(iconsDest, f));
    });
    console.log('Copied: icons/ -> www/icons/');
}

console.log('Sync to www/ completed successfully.');
