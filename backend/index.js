const express = require('express');
const cors = require('cors');
const { config } = require('dotenv');
const fs = require('fs');
const path = require('path');
const { ChatOpenAI } = require('@langchain/openai');
const { Client } = require('langsmith');
const DialogManager = require('./dialog_manager');

// Load environment variables
config();

// Enable LangSmith tracing globally
process.env.LANGCHAIN_TRACING_V2 = process.env.LANGCHAIN_TRACING_V2 || 'true';
process.env.LANGCHAIN_ENDPOINT = process.env.LANGSMITH_API_URL || 'https://api.smith.langchain.com';
process.env.LANGCHAIN_API_KEY = process.env.LANGSMITH_API_KEY;
process.env.LANGCHAIN_PROJECT = process.env.LANGSMITH_PROJECT || 'Medical-History-Interviewer';

// Debug LangSmith configuration
console.log('LangSmith Configuration:', {
  LANGSMITH_API_KEY: process.env.LANGSMITH_API_KEY ? '***' : undefined,
  LANGSMITH_API_URL: process.env.LANGSMITH_API_URL,
  LANGCHAIN_TRACING_V2: process.env.LANGCHAIN_TRACING_V2,
  LANGCHAIN_PROJECT: process.env.LANGSMITH_PROJECT
});

// Initialize LangSmith and enable tracing
const client = new Client();

// Initialize express app
const app = express();
app.use(cors());
app.use(express.json());

// Load and manage system prompt
let systemPrompt = fs.readFileSync(path.join(__dirname, 'system_prompt.txt'), 'utf-8');

// Initialize OpenAI client for summary generation
const summaryLLM = new ChatOpenAI({ 
  model: "gpt-3.5-turbo", 
  temperature: 0.3, 
  maxTokens: 1000, 
  openAIApiKey: process.env.OPENAI_API_KEY,
  tags: ["production", "medical-interview"]
});

// Initialize dialog manager
const dialogManager = new DialogManager();

// GET endpoint for default system prompt
app.get('/api/system-prompt/default', (req, res) => {
  try {
    const defaultPrompt = fs.readFileSync(path.join(__dirname, 'system_prompt.txt'), 'utf-8');
    res.json({ prompt: defaultPrompt });
  } catch (error) {
    console.error('Error reading default system prompt:', error);
    res.status(500).json({ error: 'Failed to read default system prompt' });
  }
});

// GET endpoint for current system prompt
app.get('/api/system-prompt', (req, res) => {
  try {
    res.json({ prompt: systemPrompt });
  } catch (error) {
    console.error('Error reading system prompt:', error);
    res.status(500).json({ error: 'Failed to read system prompt' });
  }
});

// PUT endpoint to update system prompt
app.put('/api/system-prompt', (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }
    systemPrompt = prompt;
    res.json({ success: true, prompt: systemPrompt });
  } catch (error) {
    console.error('Error updating system prompt:', error);
    res.status(500).json({ error: 'Failed to update system prompt' });
  }
});

// GET endpoint for conversation statistics
app.get('/api/conversation-stats', async (req, res) => {
  try {
    const stats = await dialogManager.getConversationStats();
    res.json(stats);
  } catch (error) {
    console.error('Error getting conversation stats:', error);
    res.status(500).json({ error: 'Failed to get conversation statistics' });
  }
});

// POST endpoint to toggle hybrid mode
app.post('/api/hybrid-mode', (req, res) => {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }
    
    dialogManager.setHybridMode(enabled);
    res.json({ success: true, hybridMode: enabled });
  } catch (error) {
    console.error('Error toggling hybrid mode:', error);
    res.status(500).json({ error: 'Failed to toggle hybrid mode' });
  }
});

// POST endpoint to reset interview session
app.post('/api/reset-session', async (req, res) => {
  try {
    await dialogManager.initializeSession();
    res.json({ success: true, message: 'Interview session reset successfully' });
  } catch (error) {
    console.error('Error resetting session:', error);
    res.status(500).json({ error: 'Failed to reset interview session' });
  }
});

// POST endpoint to toggle context-aware mode
app.post('/api/context-aware-mode', (req, res) => {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }
    
    dialogManager.setContextAwareMode(enabled);
    res.json({ success: true, contextAwareMode: enabled });
  } catch (error) {
    console.error('Error toggling context-aware mode:', error);
    res.status(500).json({ error: 'Failed to toggle context-aware mode' });
  }
});

// POST endpoint to toggle advanced validation
app.post('/api/advanced-validation', (req, res) => {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }
    
    dialogManager.setAdvancedValidation(enabled);
    res.json({ success: true, advancedValidation: enabled });
  } catch (error) {
    console.error('Error toggling advanced validation:', error);
    res.status(500).json({ error: 'Failed to toggle advanced validation' });
  }
});

// GET endpoint for system status
app.get('/api/system-status', (req, res) => {
  try {
    const status = dialogManager.getSystemStatus();
    res.json(status);
  } catch (error) {
    console.error('Error getting system status:', error);
    res.status(500).json({ error: 'Failed to get system status' });
  }
});

// GET endpoint for health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    version: '2.0.0',
    features: {
      hybridConversation: true,
      contextAware: true,
      advancedValidation: true,
      multiSlotExtraction: true,
      langchainIntegration: true,
      langsmithTracing: !!process.env.LANGSMITH_API_KEY
    }
  });
});

// Start or continue interview
app.post('/api/interview-next', async (req, res) => {
  try {
    const { currentSlot, response, filledSlots } = req.body;
    
    // If this is the start of the interview
    if (!currentSlot) {
      const nextQuestion = await dialogManager.getNextQuestion({});
      return res.json(nextQuestion);
    }
    
    // Process the response and get next question
    const result = await dialogManager.processResponse(currentSlot, response, filledSlots);
    
    if (!result.success) {
      return res.status(400).json({
        error: result.error,
        shouldReprompt: result.shouldReprompt,
        isClarification: result.isClarification || false
      });
    }

    // Enhanced response for hybrid extractions
    const responseData = {
      ...result,
      isHybridExtraction: result.isHybridExtraction || false,
      extractedSlots: result.extractedSlots || []
    };

    // Log hybrid extraction details
    if (result.isHybridExtraction) {
      console.log('\nHybrid Extraction Success:');
      console.log('------------------');
      console.log('Slots filled in this turn:', result.extractedSlots.length);
      result.extractedSlots.forEach(slot => {
        console.log(`${slot.slotName}: ${slot.value} (confidence: ${slot.confidence})`);
      });
      console.log('------------------\n');
    }

    res.json(responseData);
  } catch (error) {
    console.error("Error in interview-next endpoint:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Generate medical summary
app.post('/api/generate-summary', async (req, res) => {
  try {
    const { filledSlots } = req.body;
    console.log('Generating medical summary for slots:', JSON.stringify(filledSlots, null, 2));
    
    const summary = await dialogManager.generateSummary(filledSlots);
    console.log('\nSummary Generated:', summary);
    
    res.json({ summary });
  } catch (error) {
    console.error("Error generating summary:", error);
    res.status(500).json({ error: "Failed to generate medical summary" });
  }
});

// Verify LangSmith setup and start server
async function startServer() {
  try {
    // Verify LangSmith connection
    await client.listProjects();
    console.log('LangSmith connection verified');
    
    const PORT = process.env.PORT || 8000;
    app.listen(PORT, () => {
      console.log(`Medical Interview server running on http://localhost:${PORT}`);
      console.log('LangSmith tracing: enabled');
    });
  } catch (error) {
    console.error('LangSmith setup error:', error);
    const PORT = process.env.PORT || 8000;
    app.listen(PORT, () => {
      console.log(`Medical Interview server running on http://localhost:${PORT}`);
      console.log('LangSmith tracing: disabled');
    });
  }
}

startServer();
