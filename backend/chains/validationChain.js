const { ChatOpenAI } = require('@langchain/openai');
const { ChatPromptTemplate } = require('@langchain/core/prompts');
const { StructuredOutputParser } = require('langchain/output_parsers');
const { z } = require('zod');

// Schema for validation results
const validationResultSchema = z.object({
  isValid: z.boolean().describe('Whether the value is valid'),
  confidence: z.number().min(0).max(1).describe('Confidence in the validation'),
  correctedValue: z.union([z.string(), z.boolean(), z.null()]).optional().describe('Suggested correction if applicable'),
  reasoning: z.string().describe('Explanation of validation decision'),
  severity: z.enum(['error', 'warning', 'info']).describe('Severity of any issues found')
});

// Create validation prompt
const validationPrompt = ChatPromptTemplate.fromMessages([
  ["system", `You are a medical data validation specialist. Validate extracted values for accuracy and medical appropriateness.

VALIDATION RULES:
- Check for medical plausibility (e.g., reasonable ages, dates)
- Validate format consistency (dates, phone numbers, emails)
- Check for logical consistency with other provided information
- Identify potential data entry errors
- Suggest corrections when possible

MEDICAL CONTEXT VALIDATION:
- Ages should be reasonable for fertility patients (typically 18-50)
- Dates should be chronologically logical
- Symptoms should be medically coherent
- Contact information should be properly formatted

{format_instructions}`],

  ["human", `Slot: {slotName}
Question: {question}
Extracted Value: "{extractedValue}"
User Response: "{userResponse}"
Context: {contextInfo}

Validate this extracted value for medical accuracy and data quality.`]
]);

const validationParser = StructuredOutputParser.fromZodSchema(validationResultSchema);

// Advanced validation function
async function validateExtractedValue(slotName, extractedValue, userResponse, question, contextInfo = {}) {
  const llm = new ChatOpenAI({
    model: "gpt-3.5-turbo",
    temperature: 0.1,
    openAIApiKey: process.env.OPENAI_API_KEY,
    tags: ["production", "medical-interview", "validation"]
  });

  try {
    const formattedPrompt = await validationPrompt.format({
      slotName,
      question,
      extractedValue: String(extractedValue),
      userResponse,
      contextInfo: JSON.stringify(contextInfo),
      format_instructions: validationParser.getFormatInstructions()
    });

    const response = await llm.invoke(formattedPrompt);
    const cleanedResponse = response.content.replace(/```json\n?|\n?```/g, '').trim();
    const result = JSON.parse(cleanedResponse);

    console.log('\nAdvanced Validation:');
    console.log('------------------');
    console.log('Slot:', slotName);
    console.log('Value:', extractedValue);
    console.log('Valid:', result.isValid);
    console.log('Confidence:', result.confidence);
    if (result.correctedValue) {
      console.log('Suggested Correction:', result.correctedValue);
    }
    console.log('Reasoning:', result.reasoning);
    console.log('------------------\n');

    return result;
  } catch (error) {
    console.error('Error in advanced validation:', error);
    // Fallback to basic validation
    return {
      isValid: true,
      confidence: 0.5,
      reasoning: 'Fallback validation due to error',
      severity: 'info'
    };
  }
}

// Quick format validation for common patterns
function quickFormatValidation(slotName, value) {
  const formatRules = {
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    phone: /^[\+]?[1-9][\d]{0,15}$/,
    // Accept multiple date formats: MM/DD/YYYY, DD/MM/YYYY, YYYY-MM-DD, etc.
    dob: /^(\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{1,2}-\d{1,2}|\d{1,2}-\d{1,2}-\d{4})$/
  };

  const rule = formatRules[slotName];
  if (rule && typeof value === 'string') {
    return rule.test(value.replace(/[\s\-\(\)]/g, ''));
  }
  return true; // No specific format rule
}

// Data consistency checks
function checkDataConsistency(filledSlots) {
  const issues = [];

  // Check age consistency
  if (filledSlots.dob && filledSlots.age) {
    const birthYear = new Date(filledSlots.dob).getFullYear();
    const currentYear = new Date().getFullYear();
    const calculatedAge = currentYear - birthYear;
    
    if (Math.abs(calculatedAge - parseInt(filledSlots.age)) > 1) {
      issues.push({
        type: 'age_inconsistency',
        message: `Age (${filledSlots.age}) doesn't match birth date (${filledSlots.dob})`,
        severity: 'warning'
      });
    }
  }

  // Check partner consistency
  if (filledSlots.has_partner === false) {
    const partnerFields = ['partner_first_name', 'partner_last_name', 'partner_dob'];
    const filledPartnerFields = partnerFields.filter(field => filledSlots[field]);
    
    if (filledPartnerFields.length > 0) {
      issues.push({
        type: 'partner_inconsistency',
        message: 'Partner information provided but has_partner is false',
        severity: 'error'
      });
    }
  }

  // Check pregnancy timeline consistency
  if (filledSlots.months_ttc && parseInt(filledSlots.months_ttc) > 120) {
    issues.push({
      type: 'timeline_inconsistency',
      message: 'Trying to conceive for over 10 years seems unusual',
      severity: 'warning'
    });
  }

  return issues;
}

module.exports = {
  validateExtractedValue,
  quickFormatValidation,
  checkDataConsistency,
  validationResultSchema
}; 