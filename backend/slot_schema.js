const SLOT_SCHEMA = {
    slots: {
      /* --- Minimal Test Schema --- */
      "full_name": {
        "id": "full_name",
        "question": "What is your full name?",
        "slot": "full_name",
        "required": true,
        "branches": {},
        "next_default": "dob"
      },
      "dob": {
        "id": "dob",
        "question": "What is your date of birth?",
        "slot": "dob",
        "required": true,
        "branches": {},
        "next_default": "has_partner"
      },
      "has_partner": {
        "id": "has_partner",
        "question": "Do you have a partner who will be part of treatment? (yes/no)",
        "slot": "has_partner",
        "required": true,
        "branches": {},
        "next_default": "chief_complaint"
      },
      "chief_complaint": {
        "id": "chief_complaint",
        "question": "What brings you in today?",
        "slot": "chief_complaint_text",
        "required": true,
        "branches": {
          ".*fertility.*": "months_ttc",
          ".*pregnant.*": "months_ttc",
          ".*trying.*": "months_ttc"
        },
        "next_default": null
      },
      "months_ttc": {
        "id": "months_ttc",
        "question": "How many months have you been trying to get pregnant?",
        "slot": "months_ttc",
        "required": false,
        "branches": {},
        "next_default": null
      },
    }
};

// Helper function to get the next unfilled slot by walking the schema path
function getNextUnfilledSlot(filledSlots) {
  const slots = SLOT_SCHEMA.slots;
  const ROOT_SLOT = Object.keys(slots)[0]; // first slot in the schema definition

  let current = ROOT_SLOT;
  const visited = new Set();

  while (current) {
    if (visited.has(current)) {
      console.error('Branch traversal loop detected at slot:', current);
      return null; // avoid infinite loop
    }
    visited.add(current);

    // If this slot is not yet filled, ask it next
    if (filledSlots[current] === undefined) {
      return current;
    }

    const cfg = slots[current];
    const value = String(filledSlots[current] ?? '').toLowerCase();

    // Determine next slot based on branch patterns or default
    let next = cfg.next_default || null;

    if (cfg.branches && value) {
      for (const [pattern, targetSlot] of Object.entries(cfg.branches)) {
        let isMatch = false;
        try {
          // Treat branch keys as regex patterns (case-insensitive)
          const regex = new RegExp(pattern, 'i');
          isMatch = regex.test(value);
        } catch (err) {
          // If regex compilation fails, fall back to simple equality match
          const options = pattern.split('|').map(v => v.trim().toLowerCase());
          isMatch = options.includes(value);
        }

        if (isMatch) {
          next = targetSlot;
          break;
        }
      }
    }

    // Continue walking
    current = next;
  }

  return null; // All slots are filled along the traversed path
}

// Helper function to validate a slot value
function validateSlotValue(slotName, value) {
  const slotConfig = SLOT_SCHEMA.slots[slotName];
  if (!slotConfig) return { isValid: false, error: "Invalid slot name" };
  
  try {
    // If value is null or undefined, it's invalid
    if (value === null || value === undefined) {
      return { isValid: false, error: "No value provided" };
    }
    
    // Boolean values are always valid (true/false responses)
    if (typeof value === 'boolean') {
      return { isValid: true, error: null };
    }
    
    // Basic validation - most values are acceptable as strings
    // We can add more specific validation later if needed
    if (typeof value === 'string' && value.trim() === '') {
      return { isValid: false, error: "Empty value provided" };
    }
    
    // Arrays should not be empty unless explicitly allowed
    if (Array.isArray(value) && value.length === 0) {
      // Empty arrays are OK for "none" responses to list questions
      return { isValid: true, error: null };
    }
    
    return { isValid: true, error: null };
  } catch (error) {
    return {
      isValid: false,
      error: "Validation error occurred"
    };
  }
}

// Helper function to validate dates
function isValidDate(value) {
  if (!value) return false;
  const date = new Date(value);
  return date instanceof Date && !isNaN(date);
}

module.exports = { 
  SLOT_SCHEMA,
  getNextUnfilledSlot,
  validateSlotValue
};
  