const express = require('express');
const router = express.Router();
const User = require('../models/user');
const jwt = require('jsonwebtoken');
const auth = require('../middleware/auth');
const CodeSummary = require('../models/codeSummary');
const aiService = require('../services/aiService');  // Make sure to rename from AIsummery.js

// JWT secret should be in environment variables
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret_key';

// Register new user
router.post('/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email and password are required'
      });
    }
    
    // Create user
    const user = await User.create({ email, password, name });
    
    // Generate JWT token
    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '24h' });
    
    res.status(201).json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name
      }
    });
  } catch (error) {
    console.error('Registration Error:', error);
    res.status(error.message.includes('already exists') ? 409 : 500).json({
      success: false,
      message: error.message
    });
  }
});

// User login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email and password are required'
      });
    }
    
    // Find user by email
    const user = await User.getByEmail(email);
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }
    
    // Compare passwords
    const isMatch = await User.comparePassword(password, user.password);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }
    
    // Generate JWT token
    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '24h' });
    
    res.status(200).json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name
      }
    });
  } catch (error) {
    console.error('Login Error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during login',
      error: error.message
    });
  }
});

// Get current user profile
router.get('/profile', auth, async (req, res) => {
  try {
    // req.user is set by auth middleware
    res.status(200).json({
      success: true,
      user: {
        id: req.user.id,
        email: req.user.email,
        name: req.user.name
      }
    });
  } catch (error) {
    console.error('Profile Error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error getting profile',
      error: error.message
    });
  }
});

// NEW ROUTES FOR AI INTEGRATION

// Get all code summaries for a user across all sessions
router.get('/summaries', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Query summaries by user ID
    const params = {
      TableName: process.env.SUMMARIES_TABLE || 'CodeSummaries',
      FilterExpression: 'userId = :userId',
      ExpressionAttributeValues: {
        ':userId': userId
      }
    };
    
    const dynamodb = new AWS.DynamoDB.DocumentClient();
    const result = await dynamodb.scan(params).promise();
    
    res.status(200).json({
      success: true,
      summaries: result.Items || []
    });
  } catch (error) {
    console.error('Get User Summaries Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve user summaries',
      error: error.message
    });
  }
});

// Request a new AI analysis of code (on-demand)
router.post('/analyze-code', auth, async (req, res) => {
  try {
    const { code, language = 'javascript' } = req.body;
    const userId = req.user.id;
    
    if (!code) {
      return res.status(400).json({
        success: false,
        message: 'Code is required'
      });
    }
    
    // For hackathon purposes, get the user info
    const userInfo = await User.getById(userId);
    const userName = userInfo ? userInfo.name || userInfo.email : 'Unknown User';
    
    // Execute the code (simple sandbox for JavaScript)
    let result = 'Code execution not implemented';
    if (language === 'javascript') {
      try {
        const { VM } = require('vm2');
        const vm = new VM({
          timeout: 1000,
          sandbox: {}
        });
        
        result = String(vm.run(code));
      } catch (execError) {
        result = `Error: ${execError.message}`;
      }
    }
    
    // Generate AI summary
    const summary = await aiService.generateCodeSummary(
      code,
      result,
      language,
      userName
    );
    
    // Generate code quality score
    const qualityScore = await aiService.generateCodeQualityScore(code, language);
    
    // Store the summary (optional for on-demand analysis)
    const summaryData = {
      id: `ondemand-${userId}-${Date.now()}`,
      userId,
      code,
      output: result,
      summary,
      qualityScore,
      timestamp: new Date().toISOString()
    };
    
    // Return the analysis results
    res.status(200).json({
      success: true,
      analysis: summaryData
    });
    
  } catch (error) {
    console.error('Code Analysis Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to analyze code',
      error: error.message
    });
  }
});

// Update user AI preferences
router.put('/ai-preferences', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { 
      enableSummaries = true, 
      enableQualityScoring = true,
      preferredLanguage = 'javascript'
    } = req.body;
    
    // Update user with AI preferences
    const updates = {
      aiPreferences: {
        enableSummaries,
        enableQualityScoring,
        preferredLanguage
      }
    };
    
    await User.update(userId, updates);
    
    res.status(200).json({
      success: true,
      message: 'AI preferences updated successfully'
    });
  } catch (error) {
    console.error('Update AI Preferences Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update AI preferences',
      error: error.message
    });
  }
});

module.exports = router;