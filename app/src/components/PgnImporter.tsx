import { useState } from 'react';

interface PgnImporterProps {
  onImport: (pgn: string) => void;
}

export default function PgnImporter({ onImport }: PgnImporterProps) {
  const [text, setText] = useState('');

  const handleFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setText(reader.result);
        onImport(reader.result);
      }
    };
    reader.readAsText(file);
  };

  return (
    <div className="pgn-importer">
      <label className="file-drop"><span className="upload-icon">↑</span><span><strong>Open a PGN file</strong><small>Drop a file here or browse your device</small></span><input
        type="file"
        accept=".pgn,text/plain"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFile(file);
        }}
      /></label><div className="import-divider"><span>or paste notation</span></div>
      <textarea
        rows={6}
        placeholder="Or paste PGN here, e.g. 1. e4 e5 2. Nf3 Nc6 3. Bb5 ..."
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <button className="load-button" onClick={() => text.trim() && onImport(text.trim())}>Load game <span>↗</span></button>
    </div>
  );
}
