const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const { configureDB, setupTables } = require('./config/db');
require('dotenv').config();

// Import routes
const sessionRouter = require('./routes/sessionRouter');
const userRouter = require('./routes/userRoutes');

// Create Express app and HTTP server
const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || "*",
    methods: ["GET", "POST"]
  }
});

// Configure database
const { docClient: ddb } = configureDB();

// Middleware
app.use(cors());
app.use(express.json());

// API routes
app.use('/api/sessions', sessionRouter);
app.use('/api/users', userRouter);

// Setup Socket.IO for live coding
require('./sockets/liveCode')(io);

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).send('Server is running');
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({
    success: false,
    message: 'Internal server error',
    error: process.env.NODE_ENV === 'production' ? null : err.message
  });
});

// Handle 404 routes
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found'
  });
});

// Initialize server
const PORT = process.env.PORT || 3000;
const startServer = async () => {
  try {
    // Setup database tables if in development
    if (process.env.NODE_ENV !== 'production') {
      await setupTables();
    }
    
    // Start server
    server.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
      console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();

// For graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

module.exports = { app, server }; // Export for testing
