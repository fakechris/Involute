import { useEffect, useRef, useState } from 'react';
import { IcoPlus } from './Icons';

interface InlineCreateProps {
  contextLabel: string;
  onSubmit: (title: string) => void;
  onCancel: () => void;
}

export function InlineCreate({ contextLabel, onSubmit, onCancel }: InlineCreateProps) {
  const [title, setTitle] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      const trimmed = title.trim();
      if (trimmed) {
        onSubmit(trimmed);
        setTitle('');
      }
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
    }
  }

  return (
    <div className="inline-create">
      <span className="inline-create__icon">
        <IcoPlus size={13} />
      </span>
      <input
        ref={inputRef}
        className="inline-create__input"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={`Issue title — creating in ${contextLabel}`}
      />
      <span className="inline-create__hint">
        <kbd>↵</kbd> Create
        <span style={{ marginLeft: 6 }}><kbd>Esc</kbd></span>
      </span>
    </div>
  );
}
