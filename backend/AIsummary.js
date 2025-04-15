const { GoogleGenerativeAI } = require("@google/generative-ai");
require('dotenv').config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Define function schema for AI model
const functionSchema = {
  name: "analyzeCodeResults",
  description: "Classifies code errors and verifies prompt compliance",
  parameters: {
    type: "object",
    properties: {
      progress: { 
        type: "string",
        description: "Classifies code as: notStarted, justStarted, halfwayDone, almostDone, allDone"
      },
      feedback: {
        type: "string",
        description: "Instructions: You will give a short blurb (20-30 words), summarizing the general progress of the code. "
        + "Make note of any issues in what has been coded, but do not elaborate on the specifics unless it can be done concisely."
        + "If the last line appears to be incomplete, disregard it in analysis."
      }
    },
    required: ["progress", "feedback"]
  }
};

// Main function to analyze student code
async function analyzeStudentCode(prompt, studentCode) {
  const combinedPrompt = `
    Coding Assignment Prompt:
    ${prompt}

    Student Code:
    ${studentCode}

    Classification Rules:
    - notStarted (empty, no code, blank string, etc.)
    - justStarted (minimal code logic, between 1-40% done)
    - halfwayDone (beginning to develop code towards the solution, between 40-70% done)
    - almostDone (almost done, maybe some minor logical errors, between 70-99% done
    - allDone (the code is fully complete and follows the prompt"
  `;

  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-2.0-flash",  // Ensure the model name is valid
      tools: [{ functionDeclarations: [functionSchema] }]
    });

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: combinedPrompt }] }],
    });

    const functionCall = result.response?.candidates?.[0]?.content?.parts?.[0]?.functionCall;

    if (!functionCall || functionCall.name !== "analyzeCodeResults") {
      console.error("Invalid function call response from AI model");
      return defaultResponse();
    }

    const analysisResult = functionCall.args

    return analysisResult;

  } catch (error) {
    console.error("API Error Details:", error);

    if (error.status === 429) {
      console.warn("API quota exceeded - retrying after delay");
      await delay(31000);
      return analyzeStudentCode(prompt, studentCode);
    }

    return defaultResponse();
  }
}

// Helper function for default response
function defaultResponse() {
  return {
    progress: "notStarted",
    feedback: "Please start",
  };
}

// Helper function to introduce delays (for retry logic)
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function evaluateSubmission(prompt, code) {
  try {
    return await analyzeStudentCode(prompt, code);
  } catch (error) {
    console.error("Evaluation Error:", error);
    return defaultResponse();
  }
}

module.exports = { evaluateSubmission};