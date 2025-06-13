const { ChatOpenAI } = require('@langchain/openai');
const { ChatPromptTemplate } = require('@langchain/core/prompts');
const { StructuredOutputParser } = require('langchain/output_parsers');
const { z } = require('zod');

// Define the router decision schema
const routerDecisionSchema = z.object({
  action: z.enum(['extract', 'ask', 'clarify']).describe('The action to take based on the user response'),
  confidence: z.number().min(0).max(1).describe('Confidence in the decision'),
  reasoning: z.string().describe('Brief explanation of why this action was chosen'),
  extractedSlots: z.array(z.object({
    slotName: z.string(),
    value: z.union([z.string(), z.array(z.string()), z.boolean(), z.null()]),
    confidence: z.number().min(0).max(1)
  })).optional().describe('If action is extract, the slots that can be filled from this response')
});

// Create the router prompt template
const routerPrompt = ChatPromptTemplate.fromMessages([
  ["system", `You are an intelligent medical interview router. Analyze user responses to determine the best action.

ACTIONS:
- "extract": The response contains clear, extractable information for one or more slots
- "ask": The response is unclear, incomplete, or doesn't answer the current question
- "clarify": The response partially answers but needs clarification or follow-up

GUIDELINES FOR MULTI-SLOT DETECTION:
- Be AGGRESSIVE in detecting multi-slot responses
- Look for ANY information that could fill multiple slots, not just the current question
- Common multi-slot patterns:
  * Names with ages: "John Smith, 35" → first_name, last_name, dob
  * Relationship + symptoms: "married, having headaches" → has_partner, chief_complaint
  * Demographics in one go: "Sarah, 28, trying for 6 months" → first_name, dob, months_ttc
  * Contact + personal: "john@email.com, 555-1234, married" → email, phone, has_partner

EXTRACTION TRIGGERS:
- If response contains multiple pieces of personal information → "extract"
- If response mentions age, name, symptoms, relationship status together → "extract"
- If response answers the current question PLUS provides additional info → "extract"
- Only use "ask" if truly unclear or off-topic
- Only use "clarify" if partial but needs specific follow-up

Be generous with "extract" - if there's ANY extractable information beyond just the current slot, choose extract.

{format_instructions}`],

  ["human", `Current Question: {currentQuestion}
Current Slot: {currentSlot}
User Response: "{userResponse}"

Available Slots Context:
{availableSlots}

Analyze this response and decide the best action. Be aggressive about detecting multi-slot extraction opportunities.`]
]);

// Create the router parser
const routerParser = StructuredOutputParser.fromZodSchema(routerDecisionSchema);

// Multi-slot extraction for when users provide information for multiple questions
async function extractMultipleSlots(userResponse, availableSlots, currentSlot) {
  const extractionPrompt = ChatPromptTemplate.fromMessages([
    ["system", `You are a medical data extraction specialist. Extract information for multiple slots from a single user response.

Available slots and their questions:
{slotContext}

EXTRACTION RULES:
- Extract information for ANY slot that can be answered from the response, not just the current slot
- Be AGGRESSIVE in extraction - if you can reasonably infer information, extract it
- For age mentions (e.g., "35 years old"), calculate approximate birth year for dob slot
- For relationship status (married, single, partner), map to has_partner slot
- For symptoms/complaints, extract to chief_complaint_text slot
- For names, extract both first_name and last_name if both are provided
- Only extract if confidence is >0.7
- Include reasoning for each extraction

EXAMPLES:
- "I'm 35 and married" → age→dob (calculate birth year), married→has_partner:yes
- "John Smith, 28, having back pain" → first_name:John, last_name:Smith, age→dob, chief_complaint_text:back pain
- "My name is Sarah and I've been trying for 6 months" → first_name:Sarah, months_ttc:6

{format_instructions}`],
    
    ["human", `User Response: "{userResponse}"
Current Slot: {currentSlot}

Extract ALL possible slot values from this response. Be thorough and aggressive in extraction.`]
  ]);

  const multiExtractSchema = z.object({
    extractions: z.array(z.object({
      slotName: z.string(),
      value: z.union([z.string(), z.array(z.string()), z.boolean(), z.null()]),
      confidence: z.number().min(0).max(1),
      reasoning: z.string()
    }))
  });

  const multiExtractParser = StructuredOutputParser.fromZodSchema(multiExtractSchema);
  
  const llm = new ChatOpenAI({
    model: "gpt-3.5-turbo",
    temperature: 0,
    openAIApiKey: process.env.OPENAI_API_KEY,
    tags: ["production", "medical-interview", "multi-extraction"]
  });

  try {
    // Create comprehensive slot context - include more slots for better extraction
    const slotContext = Object.entries(availableSlots)
      .filter(([name, config]) => {
        // Include key slots that are commonly mentioned together
        const keySlots = [
          'first_name', 'last_name', 'dob', 'chief_complaint', 'chief_complaint_text',
          'has_partner', 'months_ttc', 'age', 'phone', 'email'
        ];
        return keySlots.includes(name) || name === currentSlot;
      })
      .map(([name, config]) => `${name}: ${config.question}`)
      .join('\n');

    const formattedPrompt = await extractionPrompt.format({
      slotContext,
      userResponse,
      currentSlot,
      format_instructions: multiExtractParser.getFormatInstructions()
    });

    const response = await llm.invoke(formattedPrompt);
    const cleanedResponse = response.content.replace(/```json\n?|\n?```/g, '').trim();
    
    console.log('\nMulti-Slot Extraction Debug:');
    console.log('------------------');
    console.log('User Response:', userResponse);
    console.log('LLM Response:', cleanedResponse);
    console.log('------------------\n');
    
    const result = JSON.parse(cleanedResponse);

    // Post-process extractions to handle special cases
    const processedExtractions = result.extractions.map(extraction => {
      // Handle age to date of birth conversion
      if (extraction.slotName === 'dob' && typeof extraction.value === 'string') {
        const ageMatch = userResponse.match(/(\d+)\s*years?\s*old/i);
        if (ageMatch) {
          const age = parseInt(ageMatch[1]);
          const currentYear = new Date().getFullYear();
          const birthYear = currentYear - age;
          extraction.value = `01/01/${birthYear}`;
          extraction.reasoning += ` (converted from age ${age})`;
        }
      }
      
      // Handle marital status to has_partner conversion
      if (extraction.slotName === 'has_partner' && typeof extraction.value === 'string') {
        const marriedKeywords = ['married', 'spouse', 'husband', 'wife', 'partner'];
        const singleKeywords = ['single', 'unmarried', 'divorced', 'widowed'];
        
        const lowerResponse = userResponse.toLowerCase();
        if (marriedKeywords.some(keyword => lowerResponse.includes(keyword))) {
          extraction.value = true;
          extraction.reasoning += ' (inferred from marital status)';
        } else if (singleKeywords.some(keyword => lowerResponse.includes(keyword))) {
          extraction.value = false;
          extraction.reasoning += ' (inferred from marital status)';
        }
      }
      
      return extraction;
    });

    return processedExtractions || [];
  } catch (error) {
    console.error('Error in multi-slot extraction:', error);
    console.error('Raw response that failed to parse:', error.message);
    return [];
  }
}

// Main router function
async function routeUserResponse(currentSlot, userResponse, availableSlots, conversationContext = {}) {
  const llm = new ChatOpenAI({
    model: "gpt-3.5-turbo",
    temperature: 0.1,
    openAIApiKey: process.env.OPENAI_API_KEY,
    tags: ["production", "medical-interview", "routing"]
  });

  try {
    const currentSlotConfig = availableSlots[currentSlot];
    if (!currentSlotConfig) {
      throw new Error(`Invalid slot: ${currentSlot}`);
    }

    // Create available slots context
    const slotsContext = Object.entries(availableSlots)
      .slice(0, 10) // Limit context to avoid token limits
      .map(([name, config]) => `${name}: ${config.question}`)
      .join('\n');

    // Format the router prompt
    const formattedPrompt = await routerPrompt.format({
      currentQuestion: currentSlotConfig.question,
      currentSlot,
      userResponse,
      availableSlots: slotsContext,
      format_instructions: routerParser.getFormatInstructions()
    });

    // Get router decision
    const response = await llm.invoke(formattedPrompt);
    const cleanedResponse = response.content.replace(/```json\n?|\n?```/g, '').trim();
    const decision = JSON.parse(cleanedResponse);

    console.log('\nRouter Decision:');
    console.log('------------------');
    console.log('Current Slot:', currentSlot);
    console.log('User Response:', userResponse);
    console.log('Action:', decision.action);
    console.log('Confidence:', decision.confidence);
    console.log('Reasoning:', decision.reasoning);
    console.log('------------------\n');

    // If action is extract, perform multi-slot extraction
    if (decision.action === 'extract') {
      const extractions = await extractMultipleSlots(userResponse, availableSlots, currentSlot);
      
      console.log('\nMulti-Slot Extraction:');
      console.log('------------------');
      console.log('Extractions found:', extractions.length);
      extractions.forEach(ext => {
        console.log(`${ext.slotName}: ${ext.value} (confidence: ${ext.confidence})`);
      });
      console.log('------------------\n');

      return {
        action: 'extract',
        confidence: decision.confidence,
        reasoning: decision.reasoning,
        extractions: extractions.filter(ext => ext.confidence >= 0.7) // Only high-confidence extractions
      };
    }

    return {
      action: decision.action,
      confidence: decision.confidence,
      reasoning: decision.reasoning,
      extractions: []
    };

  } catch (error) {
    console.error('Error in router chain:', error);
    // Fallback to simple extraction
    return {
      action: 'ask',
      confidence: 0.5,
      reasoning: 'Router error - falling back to single question mode',
      extractions: []
    };
  }
}

// Generate clarification question
async function generateClarificationQuestion(currentSlot, userResponse, slotConfig) {
  const llm = new ChatOpenAI({
    model: "gpt-3.5-turbo",
    temperature: 0.5,
    openAIApiKey: process.env.OPENAI_API_KEY,
    tags: ["production", "medical-interview", "clarification"]
  });

  const clarificationPrompt = `The user partially answered this question but needs clarification:

Question: ${slotConfig.question}
User Response: "${userResponse}"

Generate a brief, friendly follow-up question to get the missing information. Be specific about what you need.`;

  try {
    const response = await llm.invoke([
      { role: "system", content: "You are a medical interviewer asking clarifying questions. Be brief and specific." },
      { role: "user", content: clarificationPrompt }
    ]);

    return response.content;
  } catch (error) {
    console.error('Error generating clarification:', error);
    return `Could you provide more details about: ${slotConfig.question}`;
  }
}

module.exports = {
  routeUserResponse,
  extractMultipleSlots,
  generateClarificationQuestion,
  routerDecisionSchema
}; 