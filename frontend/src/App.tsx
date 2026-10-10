import { useEffect, useState } from 'react';
import { apiGet } from './api';

export default function App() {
  const [message, setMessage] = useState('Loading...');

  useEffect(() => {
    apiGet<{ message: string }>('/hello')
      .then((data) => setMessage(data.message))
      .catch(() => setMessage('Could not reach the backend'));
  }, []);

  return (
    <main>
      <h1>Orion</h1>
      <p>{message}</p>
    </main>
  );
}
