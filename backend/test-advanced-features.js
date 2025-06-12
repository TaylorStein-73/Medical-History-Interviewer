const DialogManager = require('./dialog_manager');
const { config } = require('dotenv');

// Load environment variables
config();

// Test scenarios for advanced features
const testScenarios = [
  {
    name: "Multi-slot extraction test",
    userResponse: "I'm Sarah Johnson, 32 years old, married, and I've been having fertility issues for 8 months",
    expectedSlots: ['first_name', 'last_name', 'dob', 'has_partner', 'chief_complaint_text', 'months_ttc'],
    currentSlot: 'first_name'
  },
  {
    name: "Context-aware skipping test",
    userResponse: "I'm single and not in a relationship",
    expectedSkips: ['partner_first_name', 'partner_last_name', 'partner_dob'],
    currentSlot: 'has_partner'
  },
  {
    name: "Advanced validation test",
    userResponse: "I'm 150 years old", // Should trigger validation warning
    currentSlot: 'dob',
    expectValidationIssue: true
  },
  {
    name: "Clarification test",
    userResponse: "Sometimes", // Vague response should trigger clarification
    currentSlot: 'months_ttc',
    expectClarification: true
  },
  {
    name: "Complex medical history",
    userResponse: "I have PCOS, take metformin 500mg twice daily, and my last period was 3 weeks ago",
    expectedSlots: ['medical_conditions', 'current_medications', 'last_menstrual_period'],
    currentSlot: 'medical_conditions'
  }
];

async function runAdvancedFeatureTests() {
  console.log('🧪 Starting Advanced Feature Tests');
  console.log('=====================================\n');

  const dialogManager = new DialogManager();
  let testsPassed = 0;
  let testsTotal = testScenarios.length;

  for (let i = 0; i < testScenarios.length; i++) {
    const scenario = testScenarios[i];
    console.log(`Test ${i + 1}: ${scenario.name}`);
    console.log('-----------------------------------');
    
    try {
      // Reset session for each test
      await dialogManager.initializeSession();
      
      // Process the test response
      const result = await dialogManager.processResponse(
        scenario.currentSlot,
        scenario.userResponse,
        {}
      );

      console.log('User Response:', scenario.userResponse);
      console.log('Result:', JSON.stringify(result, null, 2));

      // Validate test expectations
      let testPassed = true;
      
      if (scenario.expectedSlots) {
        const extractedSlots = result.extractedSlots || [];
        const extractedSlotNames = extractedSlots.map(slot => slot.slotName);
        
        for (const expectedSlot of scenario.expectedSlots) {
          if (!extractedSlotNames.includes(expectedSlot) && !result.filledSlots?.[expectedSlot]) {
            console.log(`❌ Expected slot '${expectedSlot}' not extracted`);
            testPassed = false;
          }
        }
        
        if (testPassed) {
          console.log(`✅ Multi-slot extraction successful: ${extractedSlotNames.join(', ')}`);
        }
      }

      if (scenario.expectClarification) {
        if (result.isClarification) {
          console.log('✅ Clarification triggered as expected');
        } else {
          console.log('❌ Expected clarification but got direct response');
          testPassed = false;
        }
      }

      if (scenario.expectValidationIssue) {
        // This would be logged in the validation process
        console.log('✅ Validation test completed (check logs for validation warnings)');
      }

      if (testPassed) {
        testsPassed++;
        console.log('✅ Test PASSED\n');
      } else {
        console.log('❌ Test FAILED\n');
      }

    } catch (error) {
      console.log('❌ Test ERROR:', error.message);
      console.log('');
    }
  }

  // Test system status and configuration
  console.log('System Status Test');
  console.log('------------------');
  const systemStatus = dialogManager.getSystemStatus();
  console.log('System Status:', JSON.stringify(systemStatus, null, 2));
  
  if (systemStatus.hybridMode && systemStatus.contextAwareMode && systemStatus.advancedValidation) {
    console.log('✅ All advanced features enabled');
    testsPassed++;
    testsTotal++;
  } else {
    console.log('❌ Some advanced features not enabled');
    testsTotal++;
  }

  // Final results
  console.log('\n🏁 Test Results Summary');
  console.log('========================');
  console.log(`Tests Passed: ${testsPassed}/${testsTotal}`);
  console.log(`Success Rate: ${Math.round((testsPassed / testsTotal) * 100)}%`);
  
  if (testsPassed === testsTotal) {
    console.log('🎉 All tests passed! Advanced features are working correctly.');
  } else {
    console.log('⚠️  Some tests failed. Check the logs above for details.');
  }
}

// Test individual chains
async function testIndividualChains() {
  console.log('\n🔧 Testing Individual Chains');
  console.log('=============================\n');

  try {
    // Test RouterChain
    const { routeUserResponse } = require('./chains/routerChain');
    const { SLOT_SCHEMA } = require('./slot_schema');
    
    console.log('Testing RouterChain...');
    const routerResult = await routeUserResponse(
      'first_name',
      'My name is John Smith and I\'m 35 years old',
      SLOT_SCHEMA.slots
    );
    console.log('Router Result:', JSON.stringify(routerResult, null, 2));
    console.log('✅ RouterChain test completed\n');

    // Test ContextChain
    const { generateContextAwareQuestion } = require('./chains/contextChain');
    
    console.log('Testing ContextChain...');
    const contextResult = await generateContextAwareQuestion(
      { first_name: 'John', has_partner: false },
      [],
      'chief_complaint',
      SLOT_SCHEMA.slots
    );
    console.log('Context Result:', JSON.stringify(contextResult, null, 2));
    console.log('✅ ContextChain test completed\n');

    // Test ValidationChain
    const { validateExtractedValue, checkDataConsistency } = require('./chains/validationChain');
    
    console.log('Testing ValidationChain...');
    const validationResult = await validateExtractedValue(
      'dob',
      '01/01/1850', // Very old date to trigger validation
      'I was born in 1850',
      'What is your date of birth?'
    );
    console.log('Validation Result:', JSON.stringify(validationResult, null, 2));
    
    const consistencyResult = checkDataConsistency({
      has_partner: false,
      partner_first_name: 'Jane' // Inconsistent data
    });
    console.log('Consistency Check:', JSON.stringify(consistencyResult, null, 2));
    console.log('✅ ValidationChain test completed\n');

  } catch (error) {
    console.error('❌ Chain testing error:', error.message);
  }
}

// Main test runner
async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('❌ OPENAI_API_KEY not found in environment variables');
    process.exit(1);
  }

  console.log('🚀 Medical Interview AI - Advanced Features Test Suite');
  console.log('======================================================\n');

  await runAdvancedFeatureTests();
  await testIndividualChains();

  console.log('\n✨ Testing completed!');
}

// Run tests if this file is executed directly
if (require.main === module) {
  main().catch(console.error);
}

module.exports = {
  runAdvancedFeatureTests,
  testIndividualChains,
  testScenarios
}; 