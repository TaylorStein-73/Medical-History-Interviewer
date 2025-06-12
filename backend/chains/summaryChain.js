const { ChatOpenAI } = require('@langchain/openai');
const { ChatPromptTemplate } = require('@langchain/core/prompts');

// Create the summary prompt template
const summaryPrompt = ChatPromptTemplate.fromMessages([
  ["system", `You are a medical professional creating a comprehensive patient summary for clinical use.

Create a well-structured, professional medical summary that includes:

1. **Patient Demographics** - Name, age, contact information
2. **Chief Complaint** - Primary reason for visit
3. **Medical History** - Chronic conditions, medications, allergies
4. **Reproductive History** - Pregnancy history, menstrual history, fertility concerns
5. **Lifestyle Factors** - Smoking, alcohol, exercise, occupational exposures
6. **Review of Systems** - Any positive findings
7. **Clinical Notes** - Areas requiring follow-up or concern

Format the summary using clear markdown sections with headers.
Be concise but thorough. Focus on clinically relevant information.
If information is missing, note it as "Not assessed" rather than omitting the section.`],
  
  ["human", `Please create a medical summary from the following patient data:

**Structured Data:**
{structuredData}

**Conversation History:**
{conversationHistory}

**Session Metadata:**
- Total interactions: {totalInteractions}
- Session duration: {sessionDuration} minutes
- Date: {sessionDate}

Create a comprehensive medical summary for clinical use.`]
]);

// Generate enhanced medical summary
async function generateEnhancedSummary(filledSlots, conversationHistory, sessionMetadata = {}) {
  try {
    const llm = new ChatOpenAI({
      model: "gpt-3.5-turbo",
      temperature: 0.3,
      maxTokens: 1500,
      openAIApiKey: process.env.OPENAI_API_KEY,
      tags: ["production", "medical-interview", "summary"]
    });
    
    // Format the prompt
    const formattedPrompt = await summaryPrompt.format({
      structuredData: JSON.stringify(filledSlots, null, 2),
      conversationHistory: conversationHistory || "No conversation history available",
      totalInteractions: sessionMetadata.totalInteractions || 0,
      sessionDuration: sessionMetadata.sessionDuration || 0,
      sessionDate: new Date().toLocaleDateString()
    });

    // Get the summary from the LLM
    const response = await llm.invoke(formattedPrompt);

    console.log('\nSummary Generation:');
    console.log('------------------');
    console.log('Structured Data Points:', Object.keys(filledSlots).length);
    console.log('Conversation Length:', conversationHistory?.length || 0);
    console.log('Summary Generated Successfully');
    console.log('------------------\n');

    return response.content;
  } catch (error) {
    console.error('Error generating enhanced summary:', error);
    throw new Error('Failed to generate enhanced medical summary');
  }
}

// Fallback to simple summary if enhanced fails
async function generateSimpleSummary(filledSlots) {
  const llm = new ChatOpenAI({
    model: "gpt-3.5-turbo",
    temperature: 0.3,
    maxTokens: 1000,
    openAIApiKey: process.env.OPENAI_API_KEY
  });

  const simplePrompt = `Generate a medical summary from this patient data:
${JSON.stringify(filledSlots, null, 2)}

Format as a professional medical summary with clear sections.`;

  try {
    const response = await llm.invoke([
      { role: "system", content: "You are a medical professional creating patient summaries." },
      { role: "user", content: simplePrompt }
    ]);

    return response.content;
  } catch (error) {
    console.error('Error generating simple summary:', error);
    throw new Error('Failed to generate medical summary');
  }
}

module.exports = {
  generateEnhancedSummary,
  generateSimpleSummary
}; 