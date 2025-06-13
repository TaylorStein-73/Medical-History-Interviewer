const { ChatOpenAI } = require('@langchain/openai');
const { ChatPromptTemplate } = require('@langchain/core/prompts');
const { StructuredOutputParser } = require('langchain/output_parsers');
const { z } = require('zod');

// Schema for context-aware responses
const contextResponseSchema = z.object({
  nextQuestion: z.string().describe('The next question to ask, contextually aware'),
  reasoning: z.string().describe('Why this question makes sense given the context'),
  priority: z.enum(['high', 'medium', 'low']).describe('Priority of this information'),
  skipRecommendation: z.array(z.string()).optional().describe('Slots that can be skipped based on context')
});

// Create context-aware question generation prompt
const contextPrompt = ChatPromptTemplate.fromMessages([
  ["system", `You are an intelligent medical interviewer that generates contextually appropriate questions.

CONTEXT AWARENESS RULES:
- Consider what information has already been gathered
- Ask follow-up questions that make logical sense
- Skip redundant or inappropriate questions based on context
- Prioritize medically relevant information
- Maintain natural conversation flow

EXAMPLES OF CONTEXT-AWARE QUESTIONING:
- If patient mentions "trying for 6 months" → prioritize fertility-related questions
- If patient is single → skip partner-related questions
- If patient mentions specific symptoms → ask relevant follow-ups
- If patient provides age → don't ask DOB separately, calculate it

{format_instructions}`],

  ["human", `Current conversation context:
Filled Slots: {filledSlots}
Recent Interactions: {recentHistory}
Next Default Slot: {nextSlot}
Available Slots: {availableSlots}

Generate a contextually appropriate next question.`]
]);

const contextParser = StructuredOutputParser.fromZodSchema(contextResponseSchema);

// Generate context-aware next question
async function generateContextAwareQuestion(filledSlots, conversationHistory, nextSlot, availableSlots) {
  const llm = new ChatOpenAI({
    model: "gpt-4o-mini",
    temperature: 0.2,
    openAIApiKey: process.env.OPENAI_API_KEY,
    tags: ["production", "medical-interview", "context-aware"]
  });

  try {
    // Create context summary
    const recentHistory = conversationHistory
      .slice(-6) // Last 3 interactions
      .map(msg => `${msg.type}: ${msg.content}`)
      .join('\n');

    const availableSlotsContext = Object.entries(availableSlots)
      .slice(0, 8)
      .map(([name, config]) => `${name}: ${config.question}`)
      .join('\n');

    const formattedPrompt = await contextPrompt.format({
      filledSlots: JSON.stringify(filledSlots, null, 2),
      recentHistory,
      nextSlot,
      availableSlots: availableSlotsContext,
      format_instructions: contextParser.getFormatInstructions()
    });

    const response = await llm.invoke(formattedPrompt);
    const cleanedResponse = response.content.replace(/```json\n?|\n?```/g, '').trim();
    const result = JSON.parse(cleanedResponse);

    console.log('\nContext-Aware Question Generation:');
    console.log('------------------');
    console.log('Next Slot:', nextSlot);
    console.log('Generated Question:', result.nextQuestion);
    console.log('Reasoning:', result.reasoning);
    console.log('Priority:', result.priority);
    console.log('------------------\n');

    return result;
  } catch (error) {
    console.error('Error in context-aware question generation:', error);
    // Fallback to default question
    const slotConfig = availableSlots[nextSlot];
    return {
      nextQuestion: slotConfig?.question || "Could you provide more information?",
      reasoning: "Fallback to default question due to context generation error",
      priority: "medium",
      skipRecommendation: []
    };
  }
}

// Intelligent slot skipping based on context
function shouldSkipSlot(slotName, filledSlots, conversationContext) {
  const skipRules = {
    // Skip partner questions if user is single
    'partner_first_name': () => filledSlots.has_partner === false,
    'partner_last_name': () => filledSlots.has_partner === false,
    'partner_dob': () => filledSlots.has_partner === false,
    'partner_sex_at_birth': () => filledSlots.has_partner === false,
    'partner_gender_identity': () => filledSlots.has_partner === false,
    'partner_pronouns': () => filledSlots.has_partner === false,
    'partner_prior_children': () => filledSlots.has_partner === false,
    'partner_children_details': () => filledSlots.has_partner === false,
    
    // Skip DOB if we already calculated it from age
    'dob': () => filledSlots.dob && filledSlots.dob.includes('01/01/'),
    
    // Skip pregnancy history questions if not trying to conceive
    'pregnancy_table': () => filledSlots.current_partner_pregs === false,
    'other_pregnancy_table': () => filledSlots.other_partner_pregs === false,
  };

  const rule = skipRules[slotName];
  return rule ? rule() : false;
}

module.exports = {
  generateContextAwareQuestion,
  shouldSkipSlot,
  contextResponseSchema
}; 