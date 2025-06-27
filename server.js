const express = require('express');
const bodyParser = require('body-parser');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const app = express();
const port = process.env.PORT || 3000;

// Admin IP address (your IP)
const adminIP = '68.102.150.181';

// In-memory database
let database = [];
let uploadedFiles = [];

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB limit
  }
});

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Middleware to check if the request is from the admin
const isAdmin = (req, res, next) => {
  // Get the real IP address (considering proxies)
  const clientIP = req.headers['x-forwarded-for'] || 
                   req.connection.remoteAddress || 
                   req.socket.remoteAddress ||
                   (req.connection.socket ? req.connection.socket.remoteAddress : null);
  
  console.log('Client IP:', clientIP, 'Admin IP:', adminIP);
  
  if (clientIP === adminIP || clientIP === `::ffff:${adminIP}`) {
    next();
  } else {
    res.redirect('/user.html');
  }
};

// Admin route to serve the admin panel
app.get('/admin', isAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Route to fetch admin data including uploaded files
app.get('/admin/data', isAdmin, (req, res) => {
  res.json({
    submissions: database,
    files: uploadedFiles
  });
});

// Route to download files (admin only)
app.get('/admin/download/:filename', isAdmin, (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, 'uploads', filename);
  
  if (fs.existsSync(filePath)) {
    res.download(filePath);
  } else {
    res.status(404).send('File not found');
  }
});

// Route to delete files (admin only)
app.delete('/admin/files/:filename', isAdmin, (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, 'uploads', filename);
  
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    uploadedFiles = uploadedFiles.filter(file => file.filename !== filename);
    res.json({ success: true, message: 'File deleted successfully' });
  } else {
    res.status(404).json({ success: false, message: 'File not found' });
  }
});

// User route to serve the user panel
app.get('/user', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'user.html'));
});

// Submit route to handle user submissions with file upload
app.post('/submit', upload.single('file'), (req, res) => {
  const info = req.body.info;
  const submission = {
    info: info,
    timestamp: new Date().toISOString(),
    ip: req.headers['x-forwarded-for'] || req.connection.remoteAddress
  };
  
  // If a file was uploaded
  if (req.file) {
    const fileInfo = {
      originalName: req.file.originalname,
      filename: req.file.filename,
      size: req.file.size,
      uploadTime: new Date().toISOString(),
      uploaderIP: req.headers['x-forwarded-for'] || req.connection.remoteAddress
    };
    uploadedFiles.push(fileInfo);
    submission.file = fileInfo;
  }
  
  database.push(submission);
  res.redirect('/user.html?success=1');
});

// Route to list available files for download (public)
app.get('/files', (req, res) => {
  const publicFiles = uploadedFiles.map(file => ({
    originalName: file.originalName,
    filename: file.filename,
    size: file.size,
    uploadTime: file.uploadTime
  }));
  res.json(publicFiles);
});

// Route for public file downloads
app.get('/download/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, 'uploads', filename);
  
  // Check if file exists in our database
  const fileExists = uploadedFiles.some(file => file.filename === filename);
  
  if (fileExists && fs.existsSync(filePath)) {
    res.download(filePath);
  } else {
    res.status(404).send('File not found');
  }
});

// Trust proxy settings (important for getting real IP behind reverse proxy)
app.set('trust proxy', true);

app.listen(port, '0.0.0.0', () => {
  console.log(`Server is running on http://0.0.0.0:${port}`);
  console.log(`Admin access from IP: ${adminIP}`);
  console.log(`Files will be stored in: ${uploadsDir}`);
});
