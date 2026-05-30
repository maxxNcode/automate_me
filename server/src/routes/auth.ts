/**
 * Auth Routes
 * Access key + username registration for multi-user access.
 * Keys are pre-generated and shared by the admin (you).
 */

import { Router, Request, Response } from 'express';
import { getDatabase } from '../services/database';

export function createAuthRoutes(): Router {
  const router = Router();
  const db = getDatabase();

  /**
   * POST /api/auth/register
   * Register with an access key + username.
   */
  router.post('/register', (req: Request, res: Response) => {
    try {
      const { accessKey, username } = req.body;

      if (!accessKey || !username) {
        return res.status(400).json({ success: false, error: 'Access key and username are required' });
      }

      const trimmedUser = username.trim().slice(0, 30);
      if (!/^[a-zA-Z0-9_]+$/.test(trimmedUser)) {
        return res.status(400).json({ success: false, error: 'Username must only contain letters, numbers, and underscores' });
      }

      // Validate the access key exists
      const key = db.validateAccessKey(accessKey.trim());
      if (!key) {
        return res.status(403).json({ success: false, error: 'Invalid access key' });
      }

      // Check if username is already taken
      const existingUser = db.getUser(trimmedUser);
      if (existingUser) {
        // If the same user with the same key, let them in (refresh)
        if (existingUser.access_key === accessKey.trim()) {
          db.touchUser(trimmedUser);
          return res.json({
            success: true,
            data: { username: trimmedUser, accessKey: accessKey.trim(), isAdmin: existingUser.is_admin === 1 },
          });
        }
        return res.status(409).json({ success: false, error: 'Username already taken' });
      }

      // Determine role from the key itself
      const keyRole = key.role || 'user';
      const isAdmin = keyRole === 'admin';

      // Register the user
      const registered = db.registerUser(trimmedUser, accessKey.trim(), isAdmin);
      if (!registered) {
        return res.status(500).json({ success: false, error: 'Failed to register user' });
      }

      return res.json({
        success: true,
        data: { username: trimmedUser, accessKey: accessKey.trim(), isAdmin },
        message: isAdmin ? 'Welcome Admin! You control the engine.' : 'Welcome aboard!',
      });
    } catch (err) {
      return res.status(500).json({ success: false, error: 'Registration failed' });
    }
  });

  /**
   * POST /api/auth/login
   * Login with existing credentials (username + access key).
   */
  router.post('/login', (req: Request, res: Response) => {
    try {
      const { username, accessKey } = req.body;

      if (!username || !accessKey) {
        return res.status(400).json({ success: false, error: 'Username and access key are required' });
      }

      const user = db.getUser(username.trim());
      if (!user || user.access_key !== accessKey.trim()) {
        return res.status(403).json({ success: false, error: 'Invalid credentials' });
      }

      db.touchUser(username.trim());

      return res.json({
        success: true,
        data: { username: username.trim(), accessKey: accessKey.trim(), isAdmin: user.is_admin === 1 },
      });
    } catch (err) {
      return res.status(500).json({ success: false, error: 'Login failed' });
    }
  });

  /**
   * POST /api/auth/generate-key
   * Generate a new access key.
   */
  router.post('/generate-key', (req: Request, res: Response) => {
    try {
      const label = req.body.label || '';
      const role: 'admin' | 'user' = req.body.role === 'admin' ? 'admin' : 'user';
      const key = db.createAccessKey(label, role);
      return res.json({
        success: true,
        data: { key, label, role },
        message: role === 'admin' ? 'Admin key generated' : 'User key generated',
      });
    } catch (err) {
      return res.status(500).json({ success: false, error: 'Failed to generate key' });
    }
  });

  /**
   * GET /api/auth/keys
   * List all access keys (admin).
   */
  router.get('/keys', (_req: Request, res: Response) => {
    try {
      const keys = db.listAccessKeys();
      return res.json({ success: true, data: keys });
    } catch (err) {
      return res.status(500).json({ success: false, error: 'Failed to list keys' });
    }
  });

  /**
   * DELETE /api/auth/keys/:key
   * Delete an access key (admin).
   */
  router.delete('/keys/:key', (req: Request, res: Response) => {
    try {
      db.deleteAccessKey(req.params.key);
      return res.json({ success: true, message: 'Key deleted' });
    } catch (err) {
      return res.status(500).json({ success: false, error: 'Failed to delete key' });
    }
  });

  /**
   * GET /api/auth/users
   * List all registered users.
   */
  router.get('/users', (_req: Request, res: Response) => {
    try {
      const users = db.listUsers();
      return res.json({ success: true, data: users });
    } catch (err) {
      return res.status(500).json({ success: false, error: 'Failed to list users' });
    }
  });

  return router;
}
