/**
 * main.js — Index page initialisation
 * Redirects to chat if an active session already exists.
 */

document.addEventListener('DOMContentLoaded', () => {
  // If user has an active session, offer to resume
  const active = CodeRAG.getCurrentSession();
  if (active?.session_id) {
    // Don't auto-redirect — let user choose to upload new or use sessions list
    // Sessions list is rendered by upload.js
  }
});