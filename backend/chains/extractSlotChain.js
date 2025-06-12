const { ChatOpenAI } = require('@langchain/openai');
const { ChatPromptTemplate } = require('@langchain/core/prompts');
const { StructuredOutputParser, OutputFixingParser } = require('langchain/output_parsers');
const { RunnableSequence } = require('@langchain/core/runnables');
const { z } = require('zod');

// Define the output schema for slot extraction
const extractionSchema = z.object({
  value: z.union([
    z.string(),
    z.array(z.string()),
    z.boolean(),
    z.null()
  ]).describe("The extracted slot value, or null if no valid value found"),
  confidence: z.number().min(0).max(1).describe("Confidence score from 0 to 1")
});

// Create the structured output parser
const structuredParser = StructuredOutputParser.fromZodSchema(extractionSchema);

// Create an output fixing parser to handle malformed responses
const createOutputFixingParser = () => {
  return OutputFixingParser.fromLLM(
    new ChatOpenAI({ 
      model: "gpt-3.5-turbo", 
      temperature: 0,
      openAIApiKey: process.env.OPENAI_API_KEY 
    }),
    structuredParser
  );
};

// Create the extraction prompt template
const extractionPrompt = ChatPromptTemplate.fromMessages([
  ["system", `You are a medical data extraction assistant. Extract the requested information from the user's response.

IMPORTANT: Return ONLY valid JSON without any markdown formatting, code blocks, or backticks.

Rules:
- For yes/no questions: return true/false as boolean
- For text responses: return the exact string
- For lists: return an array of items, empty array if "none" or "no"
- For dates: return in YYYY-MM-DD format if possible
- If no valid value can be extracted, return null
- Provide a confidence score (0-1) for your extraction

{format_instructions}

Do NOT wrap your response in markdown code blocks or backticks. Return only the JSON object.`],
  ["human", `Question: {question}
User Response: "{userResponse}"

Extract the value for this question. Return only valid JSON without markdown formatting.`]
]);

// Helper function to clean markdown formatting from LLM responses
function cleanLLMResponse(response) {
  // Remove markdown code blocks with various formats
  let cleaned = response
    .replace(/```json\s*/g, '')  // Remove ```json
    .replace(/```\s*/g, '')      // Remove ``` 
    .replace(/`{1,3}/g, '')      // Remove any remaining backticks
    .trim();
  
  // If the response starts and ends with curly braces, it's likely valid JSON
  if (cleaned.startsWith('{') && cleaned.endsWith('}')) {
    return cleaned;
  }
  
  // Try to find JSON within the response
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    return jsonMatch[0];
  }
  
  return cleaned;
}

// Build the extraction chain for a specific slot
function buildExtractChain(slotConfig) {
  const llm = new ChatOpenAI({
    model: "gpt-3.5-turbo",
    temperature: 0,
    openAIApiKey: process.env.OPENAI_API_KEY,
    tags: ["production", "medical-interview", "extraction"]
  });

  return {
    async invoke({ question, userResponse }) {
      try {
        // Format the prompt with the format instructions
        const formattedPrompt = await extractionPrompt.format({
          format_instructions: structuredParser.getFormatInstructions(),
          question: question || slotConfig.question,
          userResponse
        });

        // Get LLM response
        const llmResponse = await llm.invoke(formattedPrompt);
        
        // Clean the response to remove markdown formatting
        const cleanedResponse = cleanLLMResponse(llmResponse.content);
        
        let result;
        try {
          // Try parsing with the structured parser first
          result = await structuredParser.parse(cleanedResponse);
        } catch (parseError) {
          console.log('Structured parser failed, trying direct JSON parse...');
          try {
            // Fallback to direct JSON parsing
            result = JSON.parse(cleanedResponse);
          } catch (jsonError) {
            console.log('Direct JSON parse failed, using output fixing parser...');
            // Last resort: use output fixing parser with cleaned response
            const parser = createOutputFixingParser();
            result = await parser.parse(cleanedResponse);
          }
        }

        console.log('\nLangChain Extraction:');
        console.log('------------------');
        console.log('Question:', question || slotConfig.question);
        console.log('User Response:', userResponse);
        console.log('Raw LLM Response:', llmResponse.content);
        console.log('Cleaned Response:', cleanedResponse);
        console.log('Extracted Value:', result.value);
        console.log('Confidence:', result.confidence);
        console.log('------------------\n');

        return result;
      } catch (error) {
        console.error('Error in extraction chain:', error);
        return { value: null, confidence: 0 };
      }
    }
  };
}

// Helper function to handle special cases for yes/no responses
function preprocessResponse(userResponse, slotConfig) {
  const lowerResponse = userResponse.toLowerCase().trim();
  
  // Handle branch conditions if they exist
  if (slotConfig.branches) {
    for (const [pattern, nextSlot] of Object.entries(slotConfig.branches)) {
      const patterns = pattern.split('|');
      if (patterns.some(p => lowerResponse === p.toLowerCase())) {
        return pattern.split('|')[0]; // Return the first value from the pattern
      }
    }
  }
  
  // Default yes/no handling
  if (['yes', 'y', 'true'].includes(lowerResponse)) {
    return 'yes';
  }
  if (['no', 'n', 'false'].includes(lowerResponse)) {
    return 'no';
  }
  
  return userResponse; // Return original if no preprocessing needed
}

module.exports = {
  buildExtractChain,
  preprocessResponse,
  extractionSchema
}; 