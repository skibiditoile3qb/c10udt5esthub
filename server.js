const express = require('express');
const bodyParser = require('body-parser');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const http = require('http');
const socketIo = require('socket.io');
const ffmpeg = require('fluent-ffmpeg');

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

// Check if FFmpeg is available
function checkFFmpegAvailability() {
  return new Promise((resolve, reject) => {
    ffmpeg.getAvailableFormats((err, formats) => {
      if (err) {
        console.error('FFmpeg not available:', err.message);
        reject(new Error('FFmpeg not installed or not in PATH'));
      } else {
        console.log('FFmpeg is available');
        resolve(true);
      }
    });
  });
}

// Function to convert frames to MP4 (optimized for 2-second clips)
async function convertFramesToMP4(streamId, frames) {
  const tempDir = path.join(recordingsDir, `temp_${streamId}`);
  const outputFile = path.join(recordingsDir, `recording_${streamId}_clip.mp4`);
  
  try {
    // Check if FFmpeg is available
    await checkFFmpegAvailability();
    
    console.log(`Processing ${frames.length} frames (2-second clip) for stream ${streamId}`);
    
    // Validate frames
    if (!frames || frames.length === 0) {
      throw new Error('No frames to process');
    }
    
    // Create temp directory for frames
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    let validFrameCount = 0;
    let frameFormat = null;
    
    // Save frames as individual images with validation
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      
      if (!frame || !frame.frame) {
        console.warn(`Frame ${i} is invalid, skipping`);
        continue;
      }
      
      try {
        // Check if it's a valid base64 image (supports WebP, PNG, JPEG)
        const base64Match = frame.frame.match(/^data:image\/(\w+);base64,(.+)$/);
        if (!base64Match) {
          console.warn(`Frame ${i} is not a valid base64 image, skipping`);
          continue;
        }
        
        const imageFormat = base64Match[1]; // webp, png, jpeg, etc.
        const base64Data = base64Match[2];
        
        // Set frame format from first valid frame
        if (!frameFormat) {
          frameFormat = imageFormat;
          console.log(`Detected frame format: ${frameFormat}`);
        }
        
        const buffer = Buffer.from(base64Data, 'base64');
        
        if (buffer.length === 0) {
          console.warn(`Frame ${i} has empty buffer, skipping`);
          continue;
        }
        
        // Use appropriate file extension based on format
        const fileExtension = imageFormat === 'webp' ? 'webp' : imageFormat === 'jpeg' ? 'jpg' : 'png';
        const framePath = path.join(tempDir, `frame_${String(validFrameCount).padStart(6, '0')}.${fileExtension}`);
        fs.writeFileSync(framePath, buffer);
        validFrameCount++;
        
      } catch (frameError) {
        console.error(`Error processing frame ${i}:`, frameError.message);
        continue;
      }
    }
    
    if (validFrameCount === 0) {
      throw new Error('No valid frames found to process');
    }
    
    console.log(`Successfully saved ${validFrameCount} valid frames in ${frameFormat} format`);
    
    // Use ffmpeg to create MP4 from images
    return new Promise((resolve, reject) => {
      // Determine the input pattern based on the frame format
      const fileExtension = frameFormat === 'webp' ? 'webp' : frameFormat === 'jpeg' ? 'jpg' : 'png';
      const inputPattern = path.join(tempDir, `frame_%06d.${fileExtension}`);
      
      console.log(`Using input pattern: ${inputPattern}`);
      
      const command = ffmpeg()
        .input(inputPattern)
        .inputFPS(30) // Higher FPS for 2-second clips
        .videoCodec('libx264')
        .outputOptions([
          '-pix_fmt yuv420p',
          '-crf 18', // Higher quality for short clips
          '-preset faster', // Faster encoding for short clips
          '-movflags +faststart'
        ])
        .output(outputFile);
      
      command
        .on('start', (commandLine) => {
          console.log('FFmpeg command:', commandLine);
        })
        .on('progress', (progress) => {
          if (progress.percent) {
            console.log('Processing: ' + Math.round(progress.percent) + '% done');
          }
        })
        .on('end', () => {
          console.log(`MP4 clip creation completed: ${outputFile}`);
          // Clean up temp files
          try {
            fs.rmSync(tempDir, { recursive: true, force: true });
            console.log('Temp files cleaned up');
          } catch (cleanupError) {
            console.warn('Error cleaning up temp files:', cleanupError.message);
          }
          resolve(outputFile);
        })
        .on('error', (err) => {
          console.error('FFmpeg error:', err.message);
          console.error('FFmpeg stderr:', err.stderr || 'No stderr available');
          
          // Clean up temp files even on error
          try {
            if (fs.existsSync(tempDir)) {
              fs.rmSync(tempDir, { recursive: true, force: true });
            }
          } catch (cleanupError) {
            console.warn('Error cleaning up temp files after error:', cleanupError.message);
          }
          
          reject(new Error(`FFmpeg processing failed: ${err.message}`));
        })
        .run();
    });
    
  } catch (error) {
    console.error('Error in convertFramesToMP4:', error.message);
    
    // Clean up temp directory if it exists
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch (cleanupError) {
      console.warn('Error cleaning up after error:', cleanupError.message);
    }
    
    throw error;
  }
}

// Socket.IO for livestreaming with 2-second buffer optimization
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
    
    // Initialize recording with 2-second buffer
    recordings.set(streamId, { 
      frames: [], // Only stores last 2 seconds
      fullRecording: null, // Optional full recording
      isFullRecording: false,
      startTime: new Date(),
      isRecording: true
    });
    
    socket.join(`stream-${streamId}`);
    socket.streamId = streamId;
    
    console.log(`Stream started: ${streamId} (2-second buffer mode)`);
  });

  socket.on('stream-frame', (data) => {
    if (activeStreams.has(data.streamId)) {
      activeStreams.get(data.streamId).lastFrame = data.frame;
      
      // Ensure recording exists
      if (!recordings.has(data.streamId)) {
        recordings.set(data.streamId, { 
          frames: [],
          fullRecording: null,
          isFullRecording: false,
          startTime: new Date(),
          isRecording: true
        });
      }
      
      const recording = recordings.get(data.streamId);
      
      // Only store frames if actively recording
      if (recording.isRecording) {
        const now = Date.now();
        const frameData = {
          frame: data.frame,
          timestamp: data.timestamp || now
        };
        
        // Add to 2-second buffer
        recording.frames.push(frameData);
        
        // Keep only last 2 seconds of frames (filter by timestamp)
        const twoSecondsAgo = now - 2000;
        recording.frames = recording.frames.filter(frame => frame.timestamp > twoSecondsAgo);
        
        // Optional: Store in full recording if enabled
        if (recording.isFullRecording && recording.fullRecording) {
          recording.fullRecording.push(frameData);
          
          // Limit full recording to prevent memory issues (keep last ~10 minutes at 30fps)
          if (recording.fullRecording.length > 18000) {
            recording.fullRecording = recording.fullRecording.slice(-18000);
            console.log(`Full recording buffer trimmed for stream ${data.streamId}`);
          }
        }
        
        // Log buffer status periodically
        if (recording.frames.length % 60 === 0) { // Every ~2 seconds at 30fps
          console.log(`Stream ${data.streamId}: ${recording.frames.length} frames in 2s buffer`);
        }
      }
      
      socket.to(`stream-${data.streamId}`).emit('stream-frame', data.frame);
    }
  });

  socket.on('join-stream', (streamId) => {
    if (activeStreams.has(streamId)) {
      socket.join(`stream-${streamId}`);
      activeStreams.get(streamId).viewers.add(socket.id);
    }
  });

  socket.on('stop-stream', (streamId) => {
    console.log(`Stop stream requested for: ${streamId}`);
    if (activeStreams.has(streamId)) {
      activeStreams.delete(streamId);
    }
    if (recordings.has(streamId)) {
      const recording = recordings.get(streamId);
      recording.endTime = new Date();
      recording.isRecording = false;
      console.log(`Recording stopped for stream ${streamId}, buffer frames: ${recording.frames.length}`);
    }
  });

  socket.on('disconnect', () => {
    console.log(`Socket disconnected: ${socket.id}`);
    if (socket.streamId && activeStreams.has(socket.streamId)) {
      const streamId = socket.streamId;
      console.log(`Cleaning up stream: ${streamId}`);
      activeStreams.delete(streamId);
      if (recordings.has(streamId)) {
        const recording = recordings.get(streamId);
        recording.endTime = new Date();
        recording.isRecording = false;
        console.log(`Recording stopped for disconnected stream ${streamId}, buffer frames: ${recording.frames.length}`);
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
    const recording = recordings.get(id);
    return {
      id,
      viewers: streamData.viewers.size,
      thumbnail: streamData.thumbnail,
      title: streamData.title,
      startTime: streamData.startTime,
      bufferFrames: recording ? recording.frames.length : 0,
      fullRecordingActive: recording ? recording.isFullRecording : false
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

// Recording download endpoint - now downloads 2-second clips
app.get('/admin/recording/:streamId', isAdmin, async (req, res) => {
  const streamId = req.params.streamId;
  const type = req.query.type || 'clip'; // 'clip' or 'full'
  
  console.log(`Recording request for stream: ${streamId}, type: ${type}`);
  
  if (!recordings.has(streamId)) {
    console.log(`Recording not found for stream: ${streamId}`);
    return res.status(404).json({ error: 'Recording not found' });
  }
  
  const recording = recordings.get(streamId);
  let framesToProcess;
  let filename;
  
  if (type === 'full' && recording.fullRecording && recording.fullRecording.length > 0) {
    framesToProcess = recording.fullRecording;
    filename = `stream_${streamId}_full_recording.mp4`;
    console.log(`Processing full recording with ${framesToProcess.length} frames`);
  } else {
    framesToProcess = recording.frames;
    filename = `stream_${streamId}_2s_clip.mp4`;
    console.log(`Processing 2-second clip with ${framesToProcess.length} frames`);
  }
  
  if (!framesToProcess || framesToProcess.length === 0) {
    console.log(`No frames available for stream: ${streamId}, type: ${type}`);
    return res.status(404).json({ 
      error: 'No frames available', 
      suggestion: type === 'clip' ? 'Try downloading while stream is active' : 'Enable full recording first'
    });
  }
  
  if (framesToProcess.length < 5) {
    return res.status(400).json({ 
      error: 'Insufficient frames for recording',
      frameCount: framesToProcess.length,
      suggestion: 'Wait for more frames to be captured'
    });
  }
  
  try {
    const mp4Path = path.join(recordingsDir, `recording_${streamId}_${type}.mp4`);
    
    // Remove existing file to regenerate
    if (fs.existsSync(mp4Path)) {
      console.log(`Removing existing MP4 file: ${mp4Path}`);
      fs.unlinkSync(mp4Path);
    }
    
    // Convert frames to MP4
    console.log(`Converting ${framesToProcess.length} frames to MP4 for stream ${streamId}`);
    await convertFramesToMP4(streamId, framesToProcess);
    
    // Verify the output file exists and has content
    if (!fs.existsSync(mp4Path)) {
      throw new Error('MP4 file was not created');
    }
    
    const stats = fs.statSync(mp4Path);
    if (stats.size === 0) {
      throw new Error('MP4 file is empty');
    }
    
    console.log(`MP4 file created successfully: ${mp4Path} (${stats.size} bytes)`);
    
    // Send the MP4 file for download
    res.download(mp4Path, filename, (err) => {
      if (err) {
        console.error('Download error:', err);
        if (!res.headersSent) {
          res.status(500).send('Error downloading file');
        }
      }
    });
    
  } catch (error) {
    console.error('Error processing recording for stream', streamId, ':', error.message);
    console.error('Stack trace:', error.stack);
    
    if (!res.headersSent) {
      res.status(500).json({ 
        error: 'Error processing recording',
        details: error.message,
        streamId: streamId,
        frameCount: framesToProcess.length,
        type: type
      });
    }
  }
});

// New endpoint to start/stop full recording
app.post('/admin/streams/:streamId/full-recording', isAdmin, (req, res) => {
  const streamId = req.params.streamId;
  const action = req.body.action; // 'start' or 'stop'
  
  if (!recordings.has(streamId)) {
    return res.status(404).json({ error: 'Stream not found' });
  }
  
  const recording = recordings.get(streamId);
  
  if (action === 'start') {
    recording.fullRecording = [];
    recording.isFullRecording = true;
    console.log(`Full recording started for stream ${streamId}`);
    res.json({ success: true, message: 'Full recording started' });
  } else if (action === 'stop') {
    recording.isFullRecording = false;
    console.log(`Full recording stopped for stream ${streamId}, frames: ${recording.fullRecording ? recording.fullRecording.length : 0}`);
    res.json({ success: true, message: 'Full recording stopped' });
  } else {
    res.status(400).json({ error: 'Invalid action. Use "start" or "stop"' });
  }
});

// Endpoint to get recording status
app.get('/admin/recording/:streamId/status', isAdmin, (req, res) => {
  const streamId = req.params.streamId;
  
  if (!recordings.has(streamId)) {
    return res.status(404).json({ error: 'Recording not found' });
  }
  
  const recording = recordings.get(streamId);
  const isActive = activeStreams.has(streamId);
  
  res.json({
    streamId: streamId,
    bufferFrameCount: recording.frames.length,
    fullRecordingFrameCount: recording.fullRecording ? recording.fullRecording.length : 0,
    isRecording: recording.isRecording,
    isFullRecording: recording.isFullRecording,
    isStreamActive: isActive,
    startTime: recording.startTime,
    endTime: recording.endTime,
    duration: recording.endTime ? 
      (new Date(recording.endTime) - new Date(recording.startTime)) / 1000 : 
      (new Date() - new Date(recording.startTime)) / 1000
  });
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

// Stream ending endpoint
app.post('/admin/streams/:streamId/end', isAdmin, (req, res) => {
  const streamId = req.params.streamId;
  console.log(`Admin ending stream: ${streamId}`);
  
  if (activeStreams.has(streamId)) {
    const stream = activeStreams.get(streamId);
    io.to(stream.streamerSocketId).emit('force-stop-stream');
    activeStreams.delete(streamId);
    
    // Mark recording as ended
    if (recordings.has(streamId)) {
      const recording = recordings.get(streamId);
      recording.endTime = new Date();
      recording.isRecording = false;
      console.log(`Recording ended by admin for stream ${streamId}, buffer frames: ${recording.frames.length}`);
    }
    
    res.json({ success: true, message: 'Stream ended successfully' });
  } else {
    res.json({ success: false, message: 'Stream not found' });
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
  console.log('Optimized with 2-second frame buffer for maximum performance!');
  console.log('Checking FFmpeg availability...');
  checkFFmpegAvailability()
    .then(() => console.log('FFmpeg check passed'))
    .catch(err => console.error('FFmpeg check failed:', err.message));
});
