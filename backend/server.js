require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const express = require('express');
const bodyParser = require('body-parser');
const { Pool } = require('pg');
const axios = require('axios');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const { OpenAI } = require('openai');
const path = require('path');

// Try to load fluent-ffmpeg, handle if not installed
let ffmpeg;
try {
  ffmpeg = require('fluent-ffmpeg');
  console.log('fluent-ffmpeg loaded successfully');
} catch (error) {
  console.warn('fluent-ffmpeg not found. Audio conversion will not be available.');
  console.warn('Please install it with: npm install fluent-ffmpeg');
}

console.log('DB_USER:', process.env.DB_USER);
console.log('DB_PASSWORD:', process.env.DB_PASSWORD);
console.log('DB_HOST:', process.env.DB_HOST);
console.log('DB_PORT:', process.env.DB_PORT);
console.log('DB_NAME:', process.env.DB_NAME);

if (!process.env.DB_USER || !process.env.DB_PASSWORD || !process.env.DB_HOST || !process.env.DB_PORT || !process.env.DB_NAME) {
  console.error('Missing required environment variables');
  process.exit(1);
}

const app = express();
// Use PORT from environment variable or fall back to 3001
const port = process.env.PORT || 3001;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const pool = new Pool({
  connectionString: `postgresql://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`,
  ssl: {
    rejectUnauthorized: false
  }
});

// Configure Multer for audio file uploads with specific destination and filename
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    // Create uploads directory if it doesn't exist
    if (!fs.existsSync('uploads')) {
      fs.mkdirSync('uploads');
    }
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    // Add .webm extension to ensure OpenAI recognizes the format
    cb(null, Date.now() + '.webm');
  }
});
const upload = multer({ storage: storage });

app.use(cors());
app.use(bodyParser.json());

// Serve the React frontend
app.use(express.static(path.join(__dirname, '../chat-app/build')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../chat-app/build', 'index.html'));
});

// Store conversation history with improved language tutor prompt
let conversationHistory = [
  { 
    role: "system", 
    content: "Tu es un tuteur de français qui aide les utilisateurs à apprendre la langue de manière conversationnelle. " +
             "Réponds naturellement en français, encourage l'utilisateur à pratiquer, et corrige ses erreurs de manière bienveillante. " +
             "Si nécessaire, propose des explications sur la grammaire, la prononciation et le vocabulaire. " +
             "Suggère à l'utilisateur de répéter certaines phrases clés pour améliorer sa prononciation."
  }
];

// Function to get system prompt based on language level
function getSystemPromptByLevel(level) {
  const basePrompt = "Tu es un tuteur de français qui aide les utilisateurs à apprendre la langue de manière conversationnelle. " +
                    "Réponds naturellement en français, encourage l'utilisateur à pratiquer, et corrige ses erreurs de manière bienveillante. ";
  
  switch(level) {
    case 'beginner':
      return basePrompt + 
        "L'utilisateur est débutant. Utilise des phrases simples et courtes. " +
        "Explique clairement les concepts de base. Utilise beaucoup de répétition. " +
        "Propose souvent de répéter des phrases simples pour pratiquer la prononciation. " +
        "Inclus la traduction en anglais pour les mots importants.";
    
    case 'intermediate':
      return basePrompt + 
        "L'utilisateur a un niveau intermédiaire. Utilise des phrases de complexité moyenne. " +
        "Explique les nuances grammaticales quand approprié. " +
        "Encourage l'utilisateur à élaborer ses réponses. " +
        "Suggère des synonymes pour enrichir son vocabulaire.";
    
    case 'advanced':
      return basePrompt + 
        "L'utilisateur a un niveau avancé. N'hésite pas à utiliser un vocabulaire riche et des structures complexes. " +
        "Discute de sujets abstraits et nuancés. " +
        "Corrige surtout les erreurs subtiles de grammaire ou d'expression. " +
        "Encourage l'utilisation d'expressions idiomatiques et de registres de langue variés.";
    
    default:
      return basePrompt + "Adapte ton langage au niveau de l'utilisateur.";
  }
}

// Handle voice message upload and convert to text
app.post('/transcribe', upload.single('audio'), async (req, res) => {
  try {
    const inputPath = req.file.path;
    console.log('Received audio file:', inputPath);
    
    // Get language level from request
    const level = req.body.level || 'beginner';
    console.log('Language level:', level);
    
    // Adjust conversation history based on language level
    if (conversationHistory.length === 1) { // Only system prompt exists
      const systemPrompt = getSystemPromptByLevel(level);
      conversationHistory[0].content = systemPrompt;
    }
    
    // Ensure file exists and is readable
    if (!fs.existsSync(inputPath)) {
      throw new Error(`File does not exist: ${inputPath}`);
    }

    // Debug file info
    const stats = fs.statSync(inputPath);
    console.log('File size:', stats.size, 'bytes');
    console.log('File MIME type from request:', req.file.mimetype);

    let transcriptionFilePath = inputPath;
    
    // If ffmpeg is available, convert WebM to MP3
    if (ffmpeg) {
      // Create directory for converted files if it doesn't exist
      const outputDir = path.join(__dirname, 'uploads');
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      const outputPath = path.join(outputDir, `${Date.now()}.mp3`);

      // Convert WebM to MP3
      console.log('Converting WebM to MP3...');
      await new Promise((resolve, reject) => {
        ffmpeg(inputPath)
          .toFormat('mp3')
          .on('start', (commandLine) => {
            console.log('FFmpeg process started:', commandLine);
          })
          .on('progress', (progress) => {
            if (progress && progress.percent) {
              console.log('Processing: ' + progress.percent + '% done');
            }
          })
          .on('end', () => {
            console.log('FFmpeg process completed');
            resolve();
          })
          .on('error', (err) => {
            console.error('Error during conversion:', err);
            reject(err);
          })
          .save(outputPath);
      });

      console.log('Conversion completed, output file:', outputPath);
      transcriptionFilePath = outputPath;
    } else {
      console.warn('Skipping conversion, using original file');
    }

    // Convert speech to text using the file
    console.log('Sending file to Whisper API...');
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(transcriptionFilePath),
      model: "whisper-1",
      language: "fr",
    });

    console.log('Transcription successful:', transcription.text);
    const userMessage = transcription.text;
    conversationHistory.push({ role: 'user', content: userMessage });

    // Get chatbot response with appropriate complexity for language level
    const chatResponse = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: conversationHistory,
      temperature: 0.7,
    });

    const botMessage = chatResponse.choices[0].message.content;
    conversationHistory.push({ role: 'assistant', content: botMessage });

    // Convert response to speech with slower speed for better comprehension
    console.log('Generating speech from text:', botMessage);
    const speechResponse = await openai.audio.speech.create({
      model: 'tts-1',
      voice: 'alloy',
      input: botMessage,
      speed: 0.85  // Slower speed for better learning
    });

    // Process and log audio details
    const audioBuffer = Buffer.from(await speechResponse.arrayBuffer());
    const base64Audio = audioBuffer.toString('base64');
    console.log('Generated audio (first 50 bytes):', base64Audio.substring(0, 50) + '...');
    console.log('Audio buffer size:', audioBuffer.length, 'bytes');

    // Send response
    res.json({
      text: userMessage,
      response: botMessage,
      audio: base64Audio,
    });

    // Clean up uploaded files
    fs.unlinkSync(inputPath);  // Delete original WebM
    
    // If we converted to MP3, delete that too
    if (ffmpeg && transcriptionFilePath !== inputPath) {
      fs.unlinkSync(transcriptionFilePath); 
    }
  } catch (error) {
    console.error('Error in transcribe endpoint:', error);
    res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
});

app.post('/api/chat', async (req, res) => {
  const { message, language } = req.body;
  try {
    // Call OpenAI API and get response
    const response = await axios.post('https://api.openai.com/v1/completions', {
      model: 'text-davinci-003',
      prompt: `Translate the following English text to ${language}: '${message}'`,
      max_tokens: 60,
      temperature: 0.5
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.OPEN_AI_KEY}`
      }
    });
    const translatedMessage = response.data.choices[0].text.trim();

    // Save to database
    await pool.query('INSERT INTO messages (text, language) VALUES ($1, $2)', [translatedMessage, language]);

    res.json({ message: translatedMessage });
  } catch (error) {
    console.error('Error processing chat message', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
