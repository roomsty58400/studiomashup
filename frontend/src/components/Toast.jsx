import React from "react";

export default function Toast({ message, visible }) {
  if (!visible) return null;
  return (
    <div className="toast">
      {message}
    </div>
  );
}
