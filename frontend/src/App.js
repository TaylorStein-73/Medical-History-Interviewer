import React, { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./App.css";
import character from "./assets/character.png";
import logo from "./assets/EMDLogo.png";
import careteamimg from "./assets/care-team.png";

function App() {
  // Core state
  const [input, setInput] = useState("");
  const [chat, setChat] = useState([]);
  const [loading, setLoading] = useState(false);
  const [patientInfo, setPatientInfo] = useState("");

  // Modal states
  const [isSystemPromptOpen, setIsSystemPromptOpen] = useState(false);
  const [isAgentSettingsOpen, setIsAgentSettingsOpen] = useState(false);
  const [isPatientContextOpen, setIsPatientContextOpen] = useState(false);

  // System prompt state
  const [systemPrompt, setSystemPrompt] = useState("");
  const [editedPrompt, setEditedPrompt] = useState("");

  // Agent settings state
  const [agentSettings, setAgentSettings] = useState({
    temperature: 0.3,
    maxTokens: 900
  });
  const [editedSettings, setEditedSettings] = useState(agentSettings);

  // Interview state
  const [interviewState, setInterviewState] = useState({
    isStarted: false,
    isComplete: false,
    isReview: false,
    currentSlot: null,
    filledSlots: {},
    summary: null,
    retryCount: 0
  });

  // Refs
  const inputRef = useRef(null);
  const chatEndRef = useRef(null);

  // Fetch the default system prompt when component mounts
  useEffect(() => {
    async function fetchSystemPrompt() {
      try {
        const apiUrl = process.env.NODE_ENV === 'production'
          ? 'https://medical-history-interviewer.onrender.com'
          : (process.env.REACT_APP_API_URL || 'http://localhost:8000');

        const response = await fetch(`${apiUrl}/api/system-prompt`);
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        setSystemPrompt(data.prompt);
        setEditedPrompt(data.prompt);
      } catch (error) {
        console.error('Failed to fetch system prompt:', error);
      }
    }
    fetchSystemPrompt();
  }, []);

  // Handle chat scroll and input focus
  useEffect(() => {
    const scrollAndFocus = async () => {
      if (chatEndRef.current) {
        chatEndRef.current.scrollIntoView({ behavior: "smooth" });
      }
      await new Promise(resolve => setTimeout(resolve, 100));
      if (inputRef.current && !interviewState.isComplete) {
        inputRef.current.focus();
      }
    };
    scrollAndFocus();
  }, [chat, interviewState.isComplete]);

  // System prompt handlers
  async function handleSavePrompt() {
    try {
      const apiUrl = process.env.NODE_ENV === 'production'
        ? 'https://medical-history-interviewer.onrender.com'
        : (process.env.REACT_APP_API_URL || 'http://localhost:8000');

      const response = await fetch(`${apiUrl}/api/system-prompt`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ prompt: editedPrompt }),
      });

      if (!response.ok) {
        throw new Error('Failed to save system prompt');
      }

      const data = await response.json();
      setSystemPrompt(data.prompt);
      setIsSystemPromptOpen(false);
    } catch (error) {
      console.error('Error saving system prompt:', error);
    }
  }

  async function handleRestoreDefault() {
    try {
      const apiUrl = process.env.NODE_ENV === 'production'
        ? 'https://medical-history-interviewer.onrender.com'
        : (process.env.REACT_APP_API_URL || 'http://localhost:8000');

      const response = await fetch(`${apiUrl}/api/system-prompt/default`);
      if (!response.ok) {
        throw new Error('Failed to fetch default system prompt');
      }
      const data = await response.json();
      setEditedPrompt(data.prompt);
    } catch (error) {
      console.error('Error restoring default prompt:', error);
    }
  }

  // Agent settings handlers
  function handleSaveAgentSettings() {
    setAgentSettings(editedSettings);
    setIsAgentSettingsOpen(false);
  }

  // Start the interview
  const startInterview = async () => {
    setLoading(true);
    try {
      const apiUrl = process.env.NODE_ENV === 'production'
        ? 'https://medical-history-interviewer.onrender.com'
        : (process.env.REACT_APP_API_URL || 'http://localhost:8000');

      const res = await fetch(`${apiUrl}/api/interview-next`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentSlot: null,
          filledSlots: {}
        }),
      });

      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      const data = await res.json();

      setInterviewState(prev => ({
        ...prev,
        isStarted: true,
        isReview: data.isReview || false,
        currentSlot: data.slot ?? null,
        filledSlots: {}
      }));

      setChat([{
        from: "bot",
        text: "Hello! I'm your medical interviewer today. I'll be asking you a series of questions about your medical history. Let's begin.\n\n" + data.message
      }]);
    } catch (error) {
      console.error("Error starting interview:", error);
      setChat([{
        from: "bot",
        text: "I apologize, but there was an error starting the interview. Please try again."
      }]);
    }
    setLoading(false);
  };

  // Handle sending messages
  async function sendMessage() {
    if (!input.trim() || loading) return;
    
    const userResponse = input.trim();
    setChat(prev => [...prev, { from: "user", text: userResponse }]);
    setInput("");
    setLoading(true);

    try {
      const apiUrl = process.env.NODE_ENV === 'production'
        ? 'https://medical-history-interviewer.onrender.com'
        : (process.env.REACT_APP_API_URL || 'http://localhost:8000');

      const res = await fetch(`${apiUrl}/api/interview-next`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentSlot: interviewState.currentSlot,
          response: userResponse,
          filledSlots: interviewState.filledSlots,
          phase: interviewState.isReview ? 'review' : undefined
        }),
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ error: "Server error" }));
        throw new Error(errorData.error || `HTTP error! status: ${res.status}`);
      }
      
      const data = await res.json();

      if (!data.success && data.shouldReprompt) {
        // Handle reprompt
        if (interviewState.retryCount >= 2) {
          setChat(prev => [...prev, {
            from: "bot",
            text: "I'm having trouble understanding your response. Let's move on and you can review this information later with your doctor."
          }]);
          
          // Skip this slot and move to next question
          const skipRes = await fetch(`${apiUrl}/api/interview-next`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              currentSlot: null,
              filledSlots: interviewState.filledSlots
            }),
          });
          
          if (!skipRes.ok) throw new Error(`HTTP error! status: ${skipRes.status}`);
          const skipData = await skipRes.json();
          
          setInterviewState(prev => ({
            ...prev,
            currentSlot: skipData.slot,
            retryCount: 0
          }));
          
          setChat(prev => [...prev, {
            from: "bot",
            text: skipData.message
          }]);
        } else {
          setInterviewState(prev => ({
            ...prev,
            retryCount: prev.retryCount + 1
          }));
          
          setChat(prev => [...prev, {
            from: "bot",
            text: data.error || "I didn't understand that response. Could you please try again?"
          }]);
        }
      } else if (data.isReview) {
        // Entering or continuing review phase
        setInterviewState(prev => ({
          ...prev,
          isReview: true,
          filledSlots: data.filledSlots || prev.filledSlots
        }));

        setChat(prev => [...prev, { from: "bot", text: data.message }]);
      } else if (data.isComplete) {
        // Generate summary
        let summaryText = data.summary;

        // If backend didn't include summary, request it
        if (!summaryText) {
          const summaryRes = await fetch(`${apiUrl}/api/generate-summary`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              filledSlots: data.filledSlots
            }),
          });

          if (!summaryRes.ok) throw new Error(`HTTP error! status: ${summaryRes.status}`);
          const summaryData = await summaryRes.json();
          summaryText = summaryData.summary;
        }

        setInterviewState(prev => ({
          ...prev,
          isComplete: true,
          filledSlots: data.filledSlots,
          summary: summaryText,
          isReview: false
        }));

        setChat(prev => [...prev, {
          from: "bot",
          text: "Thank you for completing the interview. Here is a summary of your information:\n\n" + summaryText
        }]);
      } else {
        setInterviewState(prev => ({
          ...prev,
          currentSlot: data.slot,
          filledSlots: data.filledSlots,
          retryCount: 0
        }));

        setChat(prev => [...prev, {
          from: "bot",
          text: data.message
        }]);
      }
    } catch (error) {
      console.error("Error in interview:", error);
      
      // If we've tried too many times, skip this question
      if (interviewState.retryCount >= 2) {
        try {
          const apiUrl = process.env.NODE_ENV === 'production'
            ? 'https://medical-history-interviewer.onrender.com'
            : (process.env.REACT_APP_API_URL || 'http://localhost:8000');
            
          const skipRes = await fetch(`${apiUrl}/api/interview-next`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              currentSlot: null,
              filledSlots: interviewState.filledSlots
            }),
          });
          
          if (skipRes.ok) {
            const skipData = await skipRes.json();
            setInterviewState(prev => ({
              ...prev,
              currentSlot: skipData.slot,
              retryCount: 0
            }));
            
            setChat(prev => [...prev, {
              from: "bot",
              text: "I'm having trouble with this question. Let's move on to the next one.",
            }, {
              from: "bot",
              text: skipData.message
            }]);
            return;
          }
        } catch (skipError) {
          console.error("Error skipping question:", skipError);
        }
      }
      
      setInterviewState(prev => ({
        ...prev,
        retryCount: prev.retryCount + 1
      }));
      
      setChat(prev => [...prev, {
        from: "bot",
        text: error.message === "Server error" 
          ? "I'm having technical difficulties. Please try again in a moment."
          : error.message || "I couldn't understand your response. Please provide a clearer answer or ask for clarification if needed."
      }]);
    }
    setLoading(false);
  }

  // Handle keyboard input
  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!loading && input.trim()) {
        sendMessage();
      }
    }
  }

  // Empty state component
  const EmptyStateContent = () => (
    <div className="EmptyStateContainer">
      <div className="EmptyStateBackground">
        <img src={careteamimg} alt="" />
      </div>
      <h1>Welcome to EngagedMD Medical Interview</h1>
      <p>I'll guide you through a series of questions about your medical history and current health concerns. Your responses will help us provide better care.</p>
      <button
        className="StartInterviewButton"
        onClick={startInterview}
      >
        Start Interview
      </button>
    </div>
  );

  return (
    <div className="AppContainer">
      <div className="LeftNav">
        <div className="NavLogo">
          <img src={logo} alt="EngagedMD Logo" />
        </div>
        <button 
          className="NavButton" 
          onClick={() => setIsSystemPromptOpen(true)}
          title="System Prompt"
        >
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
          </svg>
          <span className="NavButtonText">System Prompt</span>
        </button>
        <button 
          className="NavButton" 
          onClick={() => setIsAgentSettingsOpen(true)}
          title="Agent Settings"
        >
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M17.982 18.725A7.488 7.488 0 0 0 12 15.75a7.488 7.488 0 0 0-5.982 2.975m11.963 0a9 9 0 1 0-11.963 0m11.963 0A8.966 8.966 0 0 1 12 21a8.966 8.966 0 0 1-5.982-2.275M15 9.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
          </svg>
          <span className="NavButtonText">Agent Settings</span>
        </button>
        <button 
          className="NavButton" 
          onClick={() => setIsPatientContextOpen(true)}
          title="Patient Context"
        >
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M11.35 3.836c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75 2.25 2.25 0 0 0-.1-.664m-5.8 0A2.251 2.251 0 0 1 13.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m8.9-4.414c.376.023.75.05 1.124.08 1.131.094 1.976 1.057 1.976 2.192V16.5A2.25 2.25 0 0 1 18 18.75h-2.25m-7.5-10.5H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V18.75m-7.5-10.5h6.375c.621 0 1.125.504 1.125 1.125v9.375m-8.25-3 1.5 1.5 3-3.75" />
          </svg>
          <span className="NavButtonText">Patient Info</span>
        </button>
      </div>

      {/* System Prompt Modal */}
      <div className={`Modal ${isSystemPromptOpen ? 'open' : ''}`}>
        <div className="ModalContent">
          <button 
            className="ModalCloseButton"
            onClick={() => {
              setEditedPrompt(systemPrompt);
              setIsSystemPromptOpen(false);
            }}
          >
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
          <h2 className="ModalTitle">System Prompt</h2>
          <div className="SystemPromptEditor">
            <textarea
              value={editedPrompt}
              onChange={(e) => setEditedPrompt(e.target.value)}
              placeholder="Enter the system prompt..."
            />
          </div>
          <div className="ModalActions">
            <button className="ModalButton secondary" onClick={handleRestoreDefault}>
              Restore Default
            </button>
            <div style={{ flex: 1 }}></div>
            <button 
              className="ModalButton secondary" 
              onClick={() => {
                setEditedPrompt(systemPrompt);
                setIsSystemPromptOpen(false);
              }}
            >
              Cancel
            </button>
            <button className="ModalButton primary" onClick={handleSavePrompt}>
              Save Changes
            </button>
          </div>
        </div>
      </div>

      {/* Agent Settings Modal */}
      <div className={`Modal ${isAgentSettingsOpen ? 'open' : ''}`}>
        <div className="ModalContent">
          <button 
            className="ModalCloseButton"
            onClick={() => {
              setEditedSettings(agentSettings);
              setIsAgentSettingsOpen(false);
            }}
          >
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
          <h2 className="ModalTitle">Agent Settings</h2>
          
          <div className="AgentSettingsForm">
            <div className="FormGroup">
              <label>
                Temperature
                <span className="ValueDisplay">{editedSettings.temperature}</span>
              </label>
              <div className="RangeWithValue">
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.1"
                  value={editedSettings.temperature}
                  onChange={(e) => setEditedSettings(prev => ({
                    ...prev,
                    temperature: parseFloat(e.target.value)
                  }))}
                />
              </div>
              <div className="description">
                Controls randomness in responses. Lower values (0.0) make responses more focused and deterministic, while higher values (1.0) make them more creative and varied.
              </div>
            </div>

            <div className="FormGroup">
              <label>
                Max Tokens
                <input
                  type="number"
                  min="100"
                  max="4000"
                  step="100"
                  value={editedSettings.maxTokens}
                  onChange={(e) => setEditedSettings(prev => ({
                    ...prev,
                    maxTokens: parseInt(e.target.value, 10)
                  }))}
                />
              </label>
              <div className="description">
                Maximum length of the response. One token is roughly 4 characters or 0.75 words. Longer responses allow for more detailed explanations but may take longer to generate.
              </div>
            </div>
          </div>

          <div className="ModalActions">
            <button 
              className="ModalButton secondary" 
              onClick={() => {
                setEditedSettings(agentSettings);
                setIsAgentSettingsOpen(false);
              }}
            >
              Cancel
            </button>
            <button className="ModalButton primary" onClick={handleSaveAgentSettings}>
              Save Changes
            </button>
          </div>
        </div>
      </div>

      {/* Patient Context Modal */}
      <div className={`Modal ${isPatientContextOpen ? 'open' : ''}`}>
        <div className="ModalContent">
          <button 
            className="ModalCloseButton"
            onClick={() => setIsPatientContextOpen(false)}
          >
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
          <h2 className="ModalTitle">Patient Information</h2>
          <div className="FormGroup">
            <label>Additional Patient Information</label>
            <textarea
              value={patientInfo}
              onChange={(e) => setPatientInfo(e.target.value)}
              placeholder="Enter any relevant patient information here..."
              className="PatientContextInput"
            />
            {interviewState.summary && (
              <>
                <label>Interview Summary</label>
                <div className="SummaryDisplay">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {interviewState.summary}
                  </ReactMarkdown>
                </div>
              </>
            )}
          </div>
          <div className="ModalActions">
            <button 
              className="ModalButton secondary" 
              onClick={() => setPatientInfo("")}
            >
              Clear Info
            </button>
            <button 
              className="ModalButton primary" 
              onClick={() => setIsPatientContextOpen(false)}
            >
              Close
            </button>
          </div>
        </div>
      </div>

      <div className="MainContent">        
        <div className={`ChatBody ${chat.length === 0 ? 'empty' : ''}`}>
          {chat.length === 0 ? (
            <EmptyStateContent />
          ) : (
            <>
              {chat.map((msg, i) => (
                <div
                  key={i}
                  className={`ChatBubbleWrapper ${msg.from === "bot" ? "BotBubbleRow" : "UserBubbleRow"}`}
                >
                  {msg.from === "bot" && (
                    <img src={character} alt="Bot" className="BrandAvatar" />
                  )}
                  <div
                    className={`ChatBubble ${msg.from === "user" ? "ChatBubbleUser" : "ChatBubbleBot"}`}
                  >
                    <span style={{ fontWeight: 600 }}>
                      {msg.from === "user" ? "You: " : ""}
                    </span>
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {msg.text}
                    </ReactMarkdown>
                  </div>
                </div>
              ))}
              {loading && (
                <div className="ChatBubbleWrapper BotBubbleRow">
                  <img src={character} alt="Bot" className="BrandAvatar" />
                  <div className="ChatBubble ChatBubbleBot">
                    <div className="typing-indicator">
                      <span></span>
                      <span></span>
                      <span></span>
                    </div>
                  </div>
                </div>
              )}
              <div ref={chatEndRef} />
            </>
          )}
        </div>

        <div className="BottomSection">
          {chat.length > 0 && !interviewState.isComplete && (
            <form
              className="ChatForm"
              onSubmit={e => { 
                e.preventDefault();
                if (!loading && input.trim()) {
                  sendMessage();
                }
              }}
            >
              <textarea
                ref={inputRef}
                className="ChatInput"
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                rows={1}
                placeholder="Type your answer..."
                disabled={loading}
                autoFocus
              />
              <button
                type="submit"
                className="ChatSendButton"
                disabled={loading || !input.trim()}
              >
                {loading ? "..." : "Submit"}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
