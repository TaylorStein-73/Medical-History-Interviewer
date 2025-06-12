// Simple memory implementation for interview conversations
class InterviewMemoryManager {
  constructor() {
    this.messages = [];
    this.sessionStartTime = new Date();
    this.interactionCount = 0;
  }

  // Save a conversation turn (question + response)
  async saveInteraction(question, userResponse, extractedValue = null, slotName = null) {
    this.interactionCount++;
    
    // Save the AI question and human response
    this.messages.push({
      type: "ai",
      content: question,
      timestamp: new Date()
    });
    
    this.messages.push({
      type: "human", 
      content: userResponse,
      timestamp: new Date(),
      extractedValue,
      slotName
    });

    // Log the interaction for debugging
    console.log('\nMemory Update:');
    console.log('------------------');
    console.log('Interaction #:', this.interactionCount);
    console.log('Question:', question);
    console.log('User Response:', userResponse);
    if (slotName && extractedValue) {
      console.log('Slot Filled:', slotName, '=', extractedValue);
    }
    console.log('Total Messages in Memory:', this.messages.length);
    console.log('------------------\n');
  }

  // Get all conversation messages
  async getMessages() {
    return this.messages;
  }

  // Get conversation summary for context
  async getConversationSummary() {
    if (this.messages.length === 0) return "No conversation yet.";

    const conversationText = this.messages
      .map(msg => `${msg.type}: ${msg.content}`)
      .join('\n');

    return {
      totalInteractions: this.interactionCount,
      sessionDuration: Math.round((new Date() - this.sessionStartTime) / 1000 / 60), // minutes
      conversationLength: this.messages.length,
      conversationText
    };
  }

  // Clear memory (for new sessions)
  async clearMemory() {
    this.messages = [];
    this.interactionCount = 0;
    this.sessionStartTime = new Date();
    console.log('Memory cleared - new session started');
  }

  // Get formatted conversation for summary generation
  async getFormattedConversation() {
    return this.messages
      .map(msg => {
        const role = msg.type === 'ai' ? 'Interviewer' : 'Patient';
        return `${role}: ${msg.content}`;
      })
      .join('\n\n');
  }

  // Get conversation statistics
  getStats() {
    return {
      totalMessages: this.messages.length,
      totalInteractions: this.interactionCount,
      sessionDuration: Math.round((new Date() - this.sessionStartTime) / 1000 / 60),
      startTime: this.sessionStartTime,
      lastActivity: this.messages.length > 0 ? this.messages[this.messages.length - 1].timestamp : null
    };
  }

  // Get filled slots from conversation
  getFilledSlots() {
    const slots = {};
    this.messages
      .filter(msg => msg.type === 'human' && msg.slotName && msg.extractedValue)
      .forEach(msg => {
        slots[msg.slotName] = msg.extractedValue;
      });
    return slots;
  }
}

// Create a singleton instance for the interview session
const interviewMemory = new InterviewMemoryManager();

module.exports = {
  InterviewMemoryManager,
  interviewMemory
}; 