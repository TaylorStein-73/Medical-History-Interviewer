const { ChatOpenAI } = require('@langchain/openai');
const { SLOT_SCHEMA, getNextUnfilledSlot, validateSlotValue } = require('./slot_schema');
const { buildExtractChain, preprocessResponse } = require('./chains/extractSlotChain');
const { interviewMemory } = require('./memory');
const { generateEnhancedSummary, generateSimpleSummary } = require('./chains/summaryChain');
const { routeUserResponse, generateClarificationQuestion } = require('./chains/routerChain');

class DialogManager {
  constructor() {
    this.llm = new ChatOpenAI({
      model: "gpt-3.5-turbo",
      temperature: 0.3,
      maxTokens: 1000,
      openAIApiKey: process.env.OPENAI_API_KEY,
      tags: ["production", "medical-interview"]
    });
    
    // Cache extraction chains for performance
    this.extractionChains = new Map();
    
    // Initialize memory for new session
    this.initializeSession();
    
    // Enable hybrid mode by default
    this.hybridMode = true;
  }

  // Initialize a new interview session
  async initializeSession() {
    await interviewMemory.clearMemory();
    console.log('New interview session initialized with hybrid conversation flow');
  }

  // Toggle hybrid mode on/off
  setHybridMode(enabled) {
    this.hybridMode = enabled;
    console.log(`Hybrid conversation mode: ${enabled ? 'enabled' : 'disabled'}`);
  }

  // Get or create an extraction chain for a specific slot
  getExtractionChain(slotName) {
    if (!this.extractionChains.has(slotName)) {
      const slotConfig = SLOT_SCHEMA.slots[slotName];
      const chain = buildExtractChain(slotConfig);
      this.extractionChains.set(slotName, chain);
    }
    return this.extractionChains.get(slotName);
  }

  // Extract slot value using LangChain (legacy single-slot method)
  async extractSlotValue(slotName, userResponse) {
    const slotConfig = SLOT_SCHEMA.slots[slotName];
    
    // First try preprocessing for simple yes/no responses
    const preprocessed = preprocessResponse(userResponse, slotConfig);
    if (preprocessed !== userResponse) {
      console.log('\nPreprocessed Response:');
      console.log('------------------');
      console.log('Original:', userResponse);
      console.log('Preprocessed:', preprocessed);
      console.log('------------------\n');
      return preprocessed;
    }
    
    // Use LangChain extraction for complex responses
    try {
      const extractionChain = this.getExtractionChain(slotName);
      const result = await extractionChain.invoke({
        question: slotConfig.question,
        userResponse
      });
      
      // Return the extracted value if confidence is high enough
      if (result.confidence >= 0.7 && result.value !== null) {
        return result.value;
      }
      
      // If confidence is low, return null to trigger reprompt
      if (result.confidence < 0.7) {
        console.log(`Low confidence extraction (${result.confidence}) for slot: ${slotName}`);
      }
      
      return null;
    } catch (error) {
      console.error('Error in LangChain extraction:', error);
      return null;
    }
  }

  // Get the next question to ask based on the current state
  getNextQuestion(filledSlots) {
    const nextSlot = getNextUnfilledSlot(filledSlots);
    if (!nextSlot) {
      return {
        isComplete: true,
        message: "Thank you for providing all the information. I'll generate a summary for your doctor."
      };
    }

    const slotConfig = SLOT_SCHEMA.slots[nextSlot];
    return {
      isComplete: false,
      slot: nextSlot,
      message: slotConfig.question
    };
  }

  // Process multiple slot extractions from router
  async processMultipleExtractions(extractions, filledSlots) {
    const updatedSlots = { ...filledSlots };
    const successfulExtractions = [];
    const failedExtractions = [];

    for (const extraction of extractions) {
      const { slotName, value, confidence } = extraction;
      
      // Validate the extracted value
      const validation = validateSlotValue(slotName, value);
      if (validation.isValid && confidence >= 0.7) {
        updatedSlots[slotName] = value;
        successfulExtractions.push({ slotName, value, confidence });
        
        // Save to memory
        const slotConfig = SLOT_SCHEMA.slots[slotName];
        await interviewMemory.saveInteraction(
          slotConfig.question, 
          `[Multi-extraction] ${value}`, 
          value, 
          slotName
        );
      } else {
        failedExtractions.push({ slotName, value, confidence, error: validation.error });
      }
    }

    console.log('\nMulti-Slot Processing:');
    console.log('------------------');
    console.log('Successful extractions:', successfulExtractions.length);
    console.log('Failed extractions:', failedExtractions.length);
    successfulExtractions.forEach(ext => {
      console.log(`✓ ${ext.slotName}: ${ext.value}`);
    });
    failedExtractions.forEach(ext => {
      console.log(`✗ ${ext.slotName}: ${ext.error || 'validation failed'}`);
    });
    console.log('------------------\n');

    return {
      updatedSlots,
      successfulExtractions,
      failedExtractions
    };
  }

  // Process user response with hybrid conversation flow
  async processResponse(currentSlot, userResponse, filledSlots) {
    const slotConfig = SLOT_SCHEMA.slots[currentSlot];
    const question = slotConfig.question;

    // Use hybrid mode if enabled
    if (this.hybridMode) {
      try {
        // Route the user response to determine best action
        const routerResult = await routeUserResponse(
          currentSlot, 
          userResponse, 
          SLOT_SCHEMA.slots,
          { filledSlots }
        );

        switch (routerResult.action) {
          case 'extract':
            // Process multiple extractions
            const multiResult = await this.processMultipleExtractions(
              routerResult.extractions, 
              filledSlots
            );

            if (multiResult.successfulExtractions.length > 0) {
              // Save the main interaction to memory
              await interviewMemory.saveInteraction(
                question, 
                userResponse, 
                multiResult.successfulExtractions[0]?.value, 
                currentSlot
              );

              // Get next question based on updated slots
              const nextQuestion = this.getNextQuestion(multiResult.updatedSlots);

              return {
                success: true,
                filledSlots: multiResult.updatedSlots,
                extractedSlots: multiResult.successfulExtractions,
                isHybridExtraction: true,
                ...nextQuestion
              };
            } else {
              // No successful extractions, fall back to ask
              await interviewMemory.saveInteraction(question, userResponse, null, currentSlot);
              return {
                success: false,
                error: "I couldn't extract clear information from your response. Could you please be more specific?",
                shouldReprompt: true
              };
            }

          case 'clarify':
            // Generate clarification question
            const clarificationQuestion = await generateClarificationQuestion(
              currentSlot, 
              userResponse, 
              slotConfig
            );
            
            await interviewMemory.saveInteraction(question, userResponse, null, currentSlot);
            
            return {
              success: false,
              error: clarificationQuestion,
              shouldReprompt: true,
              isClarification: true
            };

          case 'ask':
          default:
            // Fall back to standard single-slot processing
            break;
        }
      } catch (routerError) {
        console.warn('Router failed, falling back to standard processing:', routerError.message);
      }
    }

    // Standard single-slot processing (fallback or non-hybrid mode)
    const extractedValue = await this.extractSlotValue(currentSlot, userResponse);
    if (!extractedValue) {
      await interviewMemory.saveInteraction(question, userResponse, null, currentSlot);
      
      return {
        success: false,
        error: `Could not extract a valid value. ${slotConfig.error || 'Please try again with a clearer response.'}`,
        shouldReprompt: true
      };
    }

    // Validate the extracted value
    const validation = validateSlotValue(currentSlot, extractedValue);
    if (!validation.isValid) {
      await interviewMemory.saveInteraction(question, userResponse, null, currentSlot);
      
      return {
        success: false,
        error: validation.error,
        shouldReprompt: true
      };
    }

    // Update filled slots
    const updatedSlots = {
      ...filledSlots,
      [currentSlot]: extractedValue
    };

    // Save successful interaction to memory
    await interviewMemory.saveInteraction(question, userResponse, extractedValue, currentSlot);

    // Log the current state of slots
    console.log('\nCurrent Slot State:');
    console.log('------------------');
    console.log('Current Slot:', currentSlot);
    console.log('User Response:', userResponse);
    console.log('Extracted Value:', extractedValue);
    console.log('All Filled Slots:', JSON.stringify(updatedSlots, null, 2));
    console.log('------------------\n');

    // Get next question
    const nextQuestion = this.getNextQuestion(updatedSlots);

    return {
      success: true,
      filledSlots: updatedSlots,
      ...nextQuestion
    };
  }

  // Generate a medical summary using enhanced LangChain approach
  async generateSummary(filledSlots) {
    try {
      // Get conversation history and metadata
      const conversationHistory = await interviewMemory.getFormattedConversation();
      const sessionMetadata = await interviewMemory.getConversationSummary();

      console.log('\nGenerating Enhanced Summary:');
      console.log('------------------');
      console.log('Filled Slots:', Object.keys(filledSlots).length);
      console.log('Conversation History Length:', conversationHistory.length);
      console.log('Session Metadata:', sessionMetadata);
      console.log('------------------\n');

      // Try enhanced summary first
      try {
        const enhancedSummary = await generateEnhancedSummary(
          filledSlots, 
          conversationHistory, 
          sessionMetadata
        );
        return enhancedSummary;
      } catch (enhancedError) {
        console.warn('Enhanced summary failed, falling back to simple summary:', enhancedError.message);
        
        // Fallback to simple summary
        const simpleSummary = await generateSimpleSummary(filledSlots);
        return simpleSummary;
      }
    } catch (error) {
      console.error('Error generating summary:', error);
      throw new Error('Failed to generate medical summary');
    }
  }

  // Get conversation statistics
  async getConversationStats() {
    return await interviewMemory.getConversationSummary();
  }
}

module.exports = DialogManager; 