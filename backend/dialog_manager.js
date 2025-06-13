const { ChatOpenAI } = require('@langchain/openai');
const { SLOT_SCHEMA, getNextUnfilledSlot, validateSlotValue } = require('./slot_schema');
const { buildExtractChain, preprocessResponse } = require('./chains/extractSlotChain');
const { interviewMemory } = require('./memory');
const { generateEnhancedSummary, generateSimpleSummary } = require('./chains/summaryChain');
const { routeUserResponse, generateClarificationQuestion } = require('./chains/routerChain');
const { StructuredOutputParser } = require('langchain/output_parsers');
const { z } = require('zod');

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
      // All questions answered – move to review phase instead of immediate completion
      const reviewMessage = this.generateReviewMessage(filledSlots);
      return {
        isReview: true,
        filledSlots,
        message: reviewMessage
      };
    }

    const slotConfig = SLOT_SCHEMA.slots[nextSlot];
    return {
      isComplete: false,
      slot: nextSlot,
      message: slotConfig.question
    };
  }

  // Build a human-readable review message summarising collected info
  generateReviewMessage(filledSlots) {
    const formatValue = (val) => {
      if (typeof val === 'boolean') return val ? 'Yes' : 'No';
      if (Array.isArray(val)) return val.join(', ');
      return String(val);
    };

    const makeLabel = (question, slotName) => {
      let label = question || slotName;
      // Remove parentheses content and trailing question mark
      label = label.replace(/\(.*?\)/g, '').trim();
      if (label.endsWith('?')) label = label.slice(0, -1);
      return label.charAt(0).toUpperCase() + label.slice(1);
    };

    const lines = Object.entries(filledSlots).map(([slotName, value]) => {
      const question = SLOT_SCHEMA.slots[slotName]?.question;
      const label = makeLabel(question, slotName);
      return `- **${label}:** ${formatValue(value)}`;
    });

    return `### Please review your information\n\n${lines.join('\n')}\n\nIf anything looks incorrect or needs to be updated, just tell me (for example, \\"Change my birth year to 1987\\" or \\"I don't have a partner\\").\n\nWhen everything looks good, type **approved** to finalize.`;
  }

  // Apply corrections (LLM-driven plus regex fallback) provided by the patient
  async applyCorrections(userResponse, filledSlots) {
    let updated = { ...filledSlots };

    try {
      // -------------------
      // 1. LLM-based parser
      // -------------------
      const correctionsSchema = z.object({
        corrections: z.array(z.object({
          slotName: z.string(),
          newValue: z.any()
        }))
      });

      const parser = StructuredOutputParser.fromZodSchema(correctionsSchema);

      const slotContext = Object.entries(filledSlots)
        .map(([name, val]) => `${name}: ${val}`)
        .join('\n');

      const formatInstr = parser.getFormatInstructions();

      const prompt = `You are updating collected patient information. Here is the current data:\n${slotContext}\n\nPatient says: "${userResponse}"\n\nIdentify any corrections or updates the patient is asking for. Output ONLY JSON according to these instructions:\n${formatInstr}`;

      const llm = this.llm; // reuse instance

      const llmResp = await llm.invoke(prompt);
      const cleaned = llmResp.content.replace(/```json\n?|\n?```/g, '').trim();

      let parsed;
      try {
        parsed = JSON.parse(cleaned);
      } catch (err) {
        parsed = await parser.parse(llmResp.content).catch(() => null);
      }

      if (parsed && parsed.corrections && Array.isArray(parsed.corrections)) {
        for (const { slotName, newValue } of parsed.corrections) {
          if (SLOT_SCHEMA.slots[slotName]) {
            if (updated[slotName] !== newValue) {
              updated[slotName] = newValue;
              await interviewMemory.saveInteraction(`Correction for ${slotName}`, userResponse, newValue, slotName);
            }
          }
        }
      }
    } catch (llmErr) {
      console.warn('LLM correction parsing failed, falling back to regex:', llmErr.message);
    }

    const lower = userResponse.toLowerCase();

    // Helper to convert yes/ no phrases to boolean if slot seems boolean (starts with has_/is_ or existing value boolean)
    const assignValue = (slot, val) => {
      const current = filledSlots[slot];
      const looksBoolean = typeof current === 'boolean' || /^(has_|is_)/.test(slot);
      if (looksBoolean) {
        const v = String(val).toLowerCase();
        if (/^(yes|true|y|have|with|married)/i.test(v)) { updated[slot] = true; return; }
        if (/^(no|false|n|single|none|without)/i.test(v)) { updated[slot] = false; return; }
      }
      updated[slot] = String(val).trim();
    };

    // 1. Strict "field: value" or "field = value" pattern
    for (const slotName of Object.keys(SLOT_SCHEMA.slots)) {
      const slotPattern = slotName.replace(/_/g, '[ _]');
      const regex = new RegExp(`${slotPattern}\\s*[:=]\\s*(.+)`, 'i');
      const match = userResponse.match(regex);
      if (match && match[1]) {
        const before = updated[slotName];
        assignValue(slotName, match[1]);
        if (before !== updated[slotName]) {
          await interviewMemory.saveInteraction(`Correction for ${slotName}`, userResponse, updated[slotName], slotName);
        }
      }
    }

    // 2. Generic natural-language patterns per slot (no hard-coded aliases)
    for (const slotName of Object.keys(SLOT_SCHEMA.slots)) {
      const words = slotName.replace(/_/g, ' ');
      // change my <words> to VALUE
      const regex1 = new RegExp(`(?:change|update|correct|set).{0,40}${words}.{0,20}(?:to|is|=)\\s+(.+)`, 'i');
      // <words> is VALUE
      const regex2 = new RegExp(`${words}\\s+(?:is|=)\\s+(.+)`, 'i');
      let m = userResponse.match(regex1) || userResponse.match(regex2);
      if (m && m[1]) {
        const before = updated[slotName];
        assignValue(slotName, m[1]);
        if (before !== updated[slotName]) {
          await interviewMemory.saveInteraction(`Correction for ${slotName}`, userResponse, updated[slotName], slotName);
        }
      }

      // Additional generic booleans: "I am <word>" where word matches yes/no patterns
      if (/\bi am single\b/i.test(lower) && /has_partner/.test(slotName)) {
        updated[slotName] = false;
        await interviewMemory.saveInteraction(`Correction for ${slotName}`, userResponse, false, slotName);
      }
      if (/\bmarried\b|\bspouse\b|\bhusband\b|\bwife\b/.test(lower) && /has_partner/.test(slotName)) {
        updated[slotName] = true;
        await interviewMemory.saveInteraction(`Correction for ${slotName}`, userResponse, true, slotName);
      }
    }

    return updated;
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
              const clarificationQuestion = await generateClarificationQuestion(
                currentSlot,
                userResponse,
                slotConfig
              );
              return {
                success: false,
                error: clarificationQuestion,
                shouldReprompt: true,
                isClarification: true
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
      
      const clarificationQuestion = await generateClarificationQuestion(
        currentSlot,
        userResponse,
        slotConfig
      );

      return {
        success: false,
        error: clarificationQuestion,
        shouldReprompt: true,
        isClarification: true
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