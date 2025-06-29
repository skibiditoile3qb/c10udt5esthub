const express = require('express');
const bodyParser = require('body-parser');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const port = process.env.PORT || 3000;
const adminIP = '68.102.150.181';

let database = [];
let uploadedFiles = [];
let activeStreams = new Map(); // streamId -> { streamerSocketId, viewers: Set }
let recordings = new Map(); // streamId -> { frames: [], startTime: Date }

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

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
  limits: { fileSize: 100 * 1024 * 1024 }
});

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const checkIsAdmin = (req) => {
  let clientIP = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  if (clientIP && clientIP.includes(',')) {
    clientIP = clientIP.split(',')[0].trim();
  }
  return clientIP === adminIP || clientIP === `::ffff:${adminIP}`;
};

const isAdmin = (req, res, next) => {
  if (checkIsAdmin(req)) {
    next();
  } else {
    res.redirect('/user');
  }
};

// Socket.IO for livestreaming
io.on('connection', (socket) => {
  socket.on('start-stream', (streamId) => {
    activeStreams.set(streamId, { streamerSocketId: socket.id, viewers: new Set(), lastFrame: null });
    socket.join(`stream-${streamId}`);
    socket.streamId = streamId;
  });

  socket.on('stream-frame', (data) => {
    if (activeStreams.has(data.streamId)) {
      activeStreams.get(data.streamId).lastFrame = data.frame;
      
      if (!recordings.has(data.streamId)) {
        recordings.set(data.streamId, { frames: [], startTime: new Date() });
      }
      recordings.get(data.streamId).frames.push({
        frame: data.frame,
        timestamp: Date.now()
      });
      
      socket.to(`stream-${data.streamId}`).emit('stream-frame', data.frame);
    }
  });

  socket.on('join-stream', (streamId) => {
    if (activeStreams.has(streamId)) {
      socket.join(`stream-${streamId}`);
      activeStreams.get(streamId).viewers.add(socket.id);
      
      // Send last frame to new viewer
      const lastFrame = activeStreams.get(streamId).lastFrame;
      if (lastFrame) {
        socket.emit('stream-frame', lastFrame);
      }
    }
  });

  socket.on('stop-stream', (streamId) => {
    if (activeStreams.has(streamId)) {
      activeStreams.delete(streamId);
      // Keep recording for later download but mark as ended
      if (recordings.has(streamId)) {
        recordings.get(streamId).endTime = new Date();
      }
    }
  });

  socket.on('disconnect', () => {
    if (socket.streamId && activeStreams.has(socket.streamId)) {
      activeStreams.delete(socket.streamId);
    }
  });
});

// Routes
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

app.get('/admin/data', isAdmin, (req, res) => {
  const streams = Array.from(activeStreams.keys()).map(id => ({
    id,
    viewers: activeStreams.get(id).viewers.size
  }));
  res.json({
    submissions: database,
    files: uploadedFiles,
    streams
  });
});

app.get('/stream/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'viewer.html'));
});

app.get('/admin/download/:filename', isAdmin, (req, res) => {
  const filePath = path.join(__dirname, 'uploads', req.params.filename);
  if (fs.existsSync(filePath)) {
    res.download(filePath);
  } else {
    res.status(404).send('File not found');
  }
});

app.delete('/admin/files/:filename', isAdmin, (req, res) => {
  const filePath = path.join(__dirname, 'uploads', req.params.filename);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    uploadedFiles = uploadedFiles.filter(file => file.filename !== req.params.filename);
    res.json({ success: true });
  } else {
    res.status(404).json({ success: false, message: 'File not found' });
  }
});

app.get('/user', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'user.html'));
});

app.post('/admin/streams/:streamId/end', isAdmin, (req, res) => {
  const streamId = req.params.streamId;
  if (activeStreams.has(streamId)) {
    const stream = activeStreams.get(streamId);
    io.to(stream.streamerSocketId).emit('force-stop-stream');
    activeStreams.delete(streamId);
    res.json({ success: true });
  } else {
    res.json({ success: false });
  }
});

app.get('/admin/recording/:streamId', isAdmin, (req, res) => {
  const streamId = req.params.streamId;
  if (recordings.has(streamId)) {
    const recording = recordings.get(streamId);
    res.json(recording);
  } else {
    res.status(404).json({ error: 'Recording not found' });
  }
});

app.post('/submit', upload.single('file'), (req, res) => {
  const submission = {
    info: req.body.info,
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

app.set('trust proxy', true);

server.listen(port, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${port}`);
});
