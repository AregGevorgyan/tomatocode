const { GoogleGenerativeAI } = require("@google/generative-ai");
require("dotenv").config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Function schema Gemini will use
const functionSchema = {
  name: "analyzeStudentCode",
  description: "Classifies code errors and verifies prompt compliance",
  parameters: {
    type: "object",
    properties: {
      progress: {
        type: "string",
        description: "Classifies code as: notStarted, justStarted, halfwayDone, almostDone, allDone",
      },
      feedback: {
        type: "string",
        description: "Short 20–30 word summary of progress, noting any issues briefly. Disregard incomplete last lines.",
      },
    },
    required: ["progress", "feedback"],
  },
};

// Core function to evaluate student code
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
- almostDone (almost done, maybe some minor logical errors, between 70-99% done)
- allDone (the code is fully complete and follows the prompt)

Expected Output:
- **DO NOT** provide any explanations, extra text, or markdown.
- **ONLY** return a complete function call in this format: \`analyzeStudentCode("progress", "feedback")\`.
- **DO NOT** mark ANY assignment as complete if there is any form of logical or syntax error.
- For example, if the code is complete, return: \`analyzeStudentCode("allDone", "The code correctly prints 'Hello World' to the console.")\`
- If the code has issues, return something like: \`analyzeStudentCode("justStarted", "The code is incomplete and doesn't yet print 'Hello World'.")\`

YOUR RESPONSE: ONLY the complete function call \`analyzeStudentCode("progress", "feedback")\`, no extra text.
`;

  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-2.0-flash",
      tools: [{
        functionDeclarations: [functionSchema],
      }],
      toolConfig: {
        functionCall: {
          name: "analyzeStudentCode",
        },
      },
    });

    const stream = await model.generateContentStream({
      contents: [{
        role: "user",
        parts: [{ text: combinedPrompt }],
      }],
    });

    let bufferedResponse = ""; // To store the streamed chunks
    let completeResponse = ""; // To store the valid response

    for await (const chunk of stream.stream) {
      // Log to see what we're getting in each chunk
      console.log("Stream Chunk:", chunk);

      const candidateText = chunk.candidates?.[0]?.content?.parts?.[0]?.text || '';
      bufferedResponse += candidateText; // Concatenate the text

      // Log the candidate content to track progress
      console.log("Candidate Content:", candidateText);

      // Check if we've received a valid response
      if (bufferedResponse.includes('analyzeStudentCode(')) {
        // Check for the completion of the function call
        const regex = /analyzeStudentCode\(([^)]+)\)/;
        const match = bufferedResponse.match(regex);
        if (match && match[1]) {
          completeResponse = match[0]; // Valid function call detected
          break; // Stop processing once the function call is complete
        }
      }
    }

    // If we have a valid function call, parse it
    if (completeResponse) {
      console.log("Complete Response: ", completeResponse);
      return parseFunctionCall(completeResponse);
    } else {
      console.error("No valid function call received from Gemini.");
      return defaultResponse();
    }

  } catch (error) {
    console.error("API Error:", error);
    if (error.status === 429) {
      console.warn("API quota exceeded – retrying after delay...");
      await delay(10000);
      return analyzeStudentCode(prompt, studentCode);
    }
    return defaultResponse();
  }
}

// Function to parse the function call from the buffered response
function parseFunctionCall(response) {
  const regex = /analyzeStudentCode\(([^)]+)\)/;
  const match = response.match(regex);
  if (match && match[1]) {
    const [progress, feedback] = match[1].split(',').map(s => s.trim().replace(/["']/g, ''));
    return { progress, feedback };
  }
  return defaultResponse();
}

// Default response fallback
function defaultResponse() {
  return {
    progress: "notStarted",
    feedback: "Please start",
  };
}

// Helper delay for retry logic
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Wrapper to evaluate a submission
async function evaluateSubmission(prompt, code) {
  try {
    return await analyzeStudentCode(prompt, code);
  } catch (error) {
    console.error("Evaluation Error:", error);
    return defaultResponse();
  }
}

// Self-executing test run
(async () => {
  const result = await evaluateSubmission(
    "Create a recursive JavaScript function that calculates the sum of all integers from n to 0.",
    "const sumToZero = n => n === 0 ? 0 : n + sumToZero(n-1);"

  );
  console.log("Final result:", result);
})();

module.exports = { evaluateSubmission };
