const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const AWS = require('aws-sdk');

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

// AWS Configuration for DynamoDB
AWS.config.update({
  region: 'us-east-1', // adjust as needed
  // IAM roles on EC2 typically handle credentials
});
const ddb = new AWS.DynamoDB.DocumentClient();

// Middleware to parse JSON bodies
app.use(express.json());

// HTTP Endpoint to fetch session info (example)
app.get('/api/sessions/:sessionId', (req, res) => {
  const params = {
    TableName: 'CodingSessions',
    Key: { sessionId: req.params.sessionId },
  };

  ddb.get(params, (err, data) => {
    if (err) {
      console.error("DynamoDB read error:", err);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
    res.json(data.Item || {});
  });
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log(`New client connected: ${socket.id}`);

  // Listen for joining a coding session
  socket.on('joinSession', (sessionId) => {
    socket.join(sessionId);
    console.log(`Socket ${socket.id} joined session ${sessionId}`);
    // Optionally, load session state from DynamoDB and emit to this client
  });

  // Listen for code updates from clients
  socket.on('codeUpdate', (data) => {
    // Data example: { sessionId: 'session123', code: 'new code here' }
    
    // Broadcast the code update to everyone in the same session (except sender)
    socket.to(data.sessionId).emit('codeUpdate', data);

    // Optionally, persist the update in DynamoDB
    const params = {
      TableName: 'CodingSessions',
      Key: { sessionId: data.sessionId },
      UpdateExpression: 'set code = :c, lastUpdated = :u',
      ExpressionAttributeValues: {
        ':c': data.code,
        ':u': new Date().toISOString()
      }
    };
    
    ddb.update(params, (err, result) => {
      if (err) console.error("DynamoDB update error:", err);
      else console.log("Session updated in DynamoDB:", result);
    });
  });

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
  });
});

// Start your server on a chosen port
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
