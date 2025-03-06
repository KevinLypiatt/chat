import React from 'react';

const Message = ({ text, user }) => {
  return <div className={user ? 'user-message' : 'bot-message'}>{text}</div>;
};

export default Message;
