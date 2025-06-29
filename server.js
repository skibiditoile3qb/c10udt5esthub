const express = require('express');
const bodyParser = require('body-parser');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const http = require('http');
const socketIo = require('socket.io');
const ffmpeg = require('fluent-ffmpeg'); // You'll need to install this: npm install fluent-ffmpeg

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const port = process.env.PORT || 3000;
const adminIP = '68.102.150.181';

let database = [];
let uploadedFiles = [];
let activeStreams = new Map();
let recordings = new Map();

// Create directories for uploads and recordings
const uploadsDir = path.join(__dirname, 'uploads');
const recordingsDir = path.join(__dirname, 'recordings');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}
if (!fs.existsSync(recordingsDir)) {
  fs.mkdirSync(recordingsDir);
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

// Function to convert base64 frames to MP4
async function convertFramesToMP4(streamId, frames) {
  const tempDir = path.join(recordingsDir, `temp_${streamId}`);
  const outputFile = path.join(recordingsDir, `recording_${streamId}.mp4`);
  
  try {
    // Create temp directory for frames
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir);
    }
    
    // Save frames as individual images
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      const base64Data = frame.frame.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');
      const framePath = path.join(tempDir, `frame_${String(i).padStart(6, '0')}.png`);
      fs.writeFileSync(framePath, buffer);
    }
    
    // Use ffmpeg to create MP4 from images
    return new Promise((resolve, reject) => {
      ffmpeg()
        .input(path.join(tempDir, 'frame_%06d.png'))
        .inputFPS(30) // Adjust based on your stream FPS
        .videoCodec('libx264')
        .outputOptions(['-pix_fmt yuv420p', '-crf 23'])
        .output(outputFile)
        .on('end', () => {
          // Clean up temp files
          fs.rmSync(tempDir, { recursive: true, force: true });
          resolve(outputFile);
        })
        .on('error', (err) => {
          console.error('FFmpeg error:', err);
          // Clean up temp files even on error
          if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
          }
          reject(err);
        })
        .run();
    });
  } catch (error) {
    console.error('Error converting frames to MP4:', error);
    throw error;
  }
}

// Socket.IO for livestreaming
io.on('connection', (socket) => {
  socket.on('start-stream', (streamData) => {
    const streamId = streamData.streamId || streamData;
    const thumbnail = streamData.thumbnail || null;
    const title = streamData.streamTitle || `Stream ${streamId}`;
    const startTime = streamData.startTime || new Date().toISOString();
    
    activeStreams.set(streamId, { 
      streamerSocketId: socket.id, 
      viewers: new Set(), 
      lastFrame: null,
      thumbnail: thumbnail,
      title: title,
      startTime: startTime
    });
    
    socket.join(`stream-${streamId}`);
    socket.streamId = streamId;
    
    console.log(`Stream started: ${streamId} with thumbnail: ${thumbnail ? 'Yes' : 'No'}`);
  });

  socket.on('stream-frame', (data) => {
    if (activeStreams.has(data.streamId)) {
      activeStreams.get(data.streamId).lastFrame = data.frame;
      
      if (!recordings.has(data.streamId)) {
        recordings.set(data.streamId, { 
          frames: [], 
          startTime: new Date(),
          isRecording: true
        });
      }
      
      // Only store frames if actively recording
      if (recordings.get(data.streamId).isRecording) {
        recordings.get(data.streamId).frames.push({
          frame: data.frame,
          timestamp: Date.now()
        });
      }
      
      socket.to(`stream-${data.streamId}`).emit('stream-frame', data.frame);
    }
  });

  socket.on('join-stream', (streamId) => {
    if (activeStreams.has(streamId)) {
      socket.join(`stream-${streamId}`);
      activeStreams.get(streamId).viewers.add(socket.id);
      
      const lastFrame = activeStreams.get(streamId).lastFrame;
      if (lastFrame) {
        socket.emit('stream-frame', lastFrame);
      }
    }
  });

  socket.on('stop-stream', (streamId) => {
    if (activeStreams.has(streamId)) {
      activeStreams.delete(streamId);
      if (recordings.has(streamId)) {
        recordings.get(streamId).endTime = new Date();
        recordings.get(streamId).isRecording = false;
      }
    }
  });

  socket.on('disconnect', () => {
    if (socket.streamId && activeStreams.has(socket.streamId)) {
      const streamId = socket.streamId;
      activeStreams.delete(streamId);
      if (recordings.has(streamId)) {
        recordings.get(streamId).endTime = new Date();
        recordings.get(streamId).isRecording = false;
      }
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
  const streams = Array.from(activeStreams.keys()).map(id => {
    const streamData = activeStreams.get(id);
    return {
      id,
      viewers: streamData.viewers.size,
      thumbnail: streamData.thumbnail,
      title: streamData.title,
      startTime: streamData.startTime
    };
  });
  
  res.json({
    submissions: database,
    files: uploadedFiles,
    streams
  });
});

app.get('/stream/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'viewer.html'));
});

// Updated recording download endpoint
app.get('/admin/recording/:streamId', isAdmin, async (req, res) => {
  const streamId = req.params.streamId;
  
  if (!recordings.has(streamId)) {
    return res.status(404).json({ error: 'Recording not found' });
  }
  
  const recording = recordings.get(streamId);
  
  if (recording.frames.length === 0) {
    return res.status(404).json({ error: 'No frames recorded' });
  }
  
  try {
    // Check if MP4 file already exists
    const mp4Path = path.join(recordingsDir, `recording_${streamId}.mp4`);
    
    if (!fs.existsSync(mp4Path)) {
      // Convert frames to MP4
      console.log(`Converting ${recording.frames.length} frames to MP4 for stream ${streamId}`);
      await convertFramesToMP4(streamId, recording.frames);
    }
    
    // Send the MP4 file for download
    res.download(mp4Path, `stream_${streamId}_recording.mp4`, (err) => {
      if (err) {
        console.error('Download error:', err);
        res.status(500).send('Error downloading file');
      }
    });
    
  } catch (error) {
    console.error('Error processing recording:', error);
    res.status(500).json({ error: 'Error processing recording' });
  }
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
    
    // Mark recording as ended
    if (recordings.has(streamId)) {
      recordings.get(streamId).endTime = new Date();
      recordings.get(streamId).isRecording = false;
    }
    
    res.json({ success: true });
  } else {
    res.json({ success: false });
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
