import React, { useState } from 'react';
import axios from 'axios';

const Chat = () => {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [language, setLanguage] = useState('fr');

  const handleSend = async () => {
    const response = await axios.post('/api/chat', { message: input, language });
    setMessages([...messages, { text: input, user: true }, { text: response.data.message, user: false }]);
    setInput('');
  };

  const handleSpeech = () => {
    const recognition = new window.webkitSpeechRecognition();
    recognition.lang = language === 'fr' ? 'fr-FR' : 'en-US';
    recognition.start();

    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      setInput(transcript);
    };

    recognition.onerror = (event) => {
      console.error('Speech recognition error', event.error);
    };
  };

  return (
    <div>
      <select value={language} onChange={(e) => setLanguage(e.target.value)}>
        <option value="fr">French</option>
        <option value="en">English</option>
      </select>
      <div>
        {messages.map((msg, index) => (
          <div key={index} className={msg.user ? 'user-message' : 'bot-message'}>
            {msg.text}
          </div>
        ))}
      </div>
      <input value={input} onChange={(e) => setInput(e.target.value)} />
      <button onClick={handleSend}>Send</button>
      <button onClick={handleSpeech}>🎤</button>
    </div>
  );
};

export default Chat;
