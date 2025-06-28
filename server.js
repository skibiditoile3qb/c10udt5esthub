const express = require('express');
const bodyParser = require('body-parser');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const port = process.env.PORT || 3000;

// Admin IP address (your IP)
const adminIP = '68.102.150.181';

// In-memory database
let database = [];
let uploadedFiles = [];
let activeStreams = new Map(); // Store active streams

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
    fileSize: 100 * 1024 * 1024 // 100MB limit
  }
});

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Function to check if the request is from the admin
const checkIsAdmin = (req) => {
  let clientIP = req.headers['x-forwarded-for'] || 
                 req.connection.remoteAddress || 
                 req.socket.remoteAddress ||
                 (req.connection.socket ? req.connection.socket.remoteAddress : null);
  
  if (clientIP && clientIP.includes(',')) {
    clientIP = clientIP.split(',')[0].trim();
  }
  
  console.log('Client IP:', clientIP, 'Admin IP:', adminIP);
  
  return clientIP === adminIP || clientIP === `::ffff:${adminIP}`;
};

// Middleware to check if the request is from the admin
const isAdmin = (req, res, next) => {
  if (checkIsAdmin(req)) {
    next();
  } else {
    res.redirect('/user');
  }
};

// Socket.IO for WebRTC signaling and streaming
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  
  // Handle stream start
  socket.on('start-stream', (data) => {
    const { streamType, userInfo } = data;
    activeStreams.set(socket.id, {
      type: streamType,
      userInfo: userInfo,
      startTime: new Date(),
      socketId: socket.id
    });
    
    // Notify admins about new stream
    socket.broadcast.emit('new-stream', {
      streamId: socket.id,
      type: streamType,
      userInfo: userInfo,
      startTime: new Date()
    });
    
    console.log(`Stream started: ${streamType} from ${socket.id}`);
  });
  
  // Handle WebRTC signaling
  socket.on('offer', (data) => {
    socket.broadcast.emit('offer', { ...data, from: socket.id });
  });
  
  socket.on('answer', (data) => {
    socket.to(data.to).emit('answer', { ...data, from: socket.id });
  });
  
  socket.on('ice-candidate', (data) => {
    socket.broadcast.emit('ice-candidate', { ...data, from: socket.id });
  });
  
  // Handle stream data chunks (for recording/saving)
  socket.on('stream-chunk', (data) => {
    // You can save chunks here if needed
    console.log('Received stream chunk from:', socket.id);
  });
  
  // Handle stream stop
  socket.on('stop-stream', () => {
    activeStreams.delete(socket.id);
    socket.broadcast.emit('stream-ended', socket.id);
    console.log('Stream ended:', socket.id);
  });
  
  // Handle disconnect
  socket.on('disconnect', () => {
    activeStreams.delete(socket.id);
    socket.broadcast.emit('stream-ended', socket.id);
    console.log('User disconnected:', socket.id);
  });
  
  // Get active streams (for admins)
  socket.on('get-active-streams', () => {
    const streams = Array.from(activeStreams.entries()).map(([id, data]) => ({
      streamId: id,
      ...data
    }));
    socket.emit('active-streams', streams);
  });
});

// Existing routes...
app.get('/', (req, res) => {
  if (checkIsAdmin(req)) {
    res.sendFile(path.join(__dirname, 'public', 'admin-home.html'));
  } else {
    res.redirect('/user');
  }
});

app.get('/admin', isAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-home.html'));
});

app.get('/admin/view', isAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-view.html'));
});

// New route for stream viewer (admin only)
app.get('/admin/streams', isAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-streams.html'));
});

app.get('/admin/data', isAdmin, (req, res) => {
  res.json({
    submissions: database,
    files: uploadedFiles
  });
});

app.get('/admin/download/:filename', isAdmin, (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, 'uploads', filename);
  
  if (fs.existsSync(filePath)) {
    res.download(filePath);
  } else {
    res.status(404).send('File not found');
  }
});

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

app.get('/user', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'user.html'));
});

app.post('/submit', upload.single('file'), (req, res) => {
  const info = req.body.info;
  const submission = {
    info: info,
    timestamp: new Date().toISOString(),
    ip: req.headers['x-forwarded-for'] || req.connection.remoteAddress
  };
  
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
  res.redirect('/user?success=1');
});

app.get('/files', (req, res) => {
  const publicFiles = uploadedFiles.map(file => ({
    originalName: file.originalName,
    filename: file.filename,
    size: file.size,
    uploadTime: file.uploadTime
  }));
  res.json(publicFiles);
});

app.get('/download/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, 'uploads', filename);
  
  const fileExists = uploadedFiles.some(file => file.filename === filename);
  
  if (fileExists && fs.existsSync(filePath)) {
    res.download(filePath);
  } else {
    res.status(404).send('File not found');
  }
});

app.set('trust proxy', true);

server.listen(port, '0.0.0.0', () => {
  console.log(`Server is running on http://0.0.0.0:${port}`);
  console.log(`Admin access from IP: ${adminIP}`);
  console.log(`Files will be stored in: ${uploadsDir}`);
  console.log(`WebRTC streaming enabled`);
});
