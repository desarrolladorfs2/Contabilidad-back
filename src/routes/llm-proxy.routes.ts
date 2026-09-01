import { Router, Response } from 'express';
import fetch from 'node-fetch';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';

const router = Router();
router.use(authMiddleware);

// GET /api/llm-proxy/config — devuelve el modelo activo al frontend
router.get('/config', (_req: AuthRequest, res: Response): void => {
  const available = !!(process.env.LLM_API_KEY && process.env.LLM_BASE_URL);
  res.json({
    model:     process.env.LLM_MODEL || 'gemini-2.0-flash',
    available,
  });
});

// POST /api/llm-proxy/* — proxy transparente hacia cualquier LLM OpenAI-compatible
router.post('*', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const apiKey  = process.env.LLM_API_KEY;
    const baseURL = (process.env.LLM_BASE_URL || '').replace(/\/$/, '');

    if (!apiKey || !baseURL) {
      res.status(503).json({ error: 'Asistente IA no configurado (LLM_API_KEY / LLM_BASE_URL)' });
      return;
    }

    // req.path viene sin el prefijo /api/llm-proxy gracias al app.use mount
    const targetURL = `${baseURL}${req.path}`;

    const upstream = await fetch(targetURL, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(req.body),
    });

    const contentType = upstream.headers.get('content-type') || '';
    res.status(upstream.status);

    // Pass-through SSE streaming para respuestas en tiempo real
    if (contentType.includes('text/event-stream') || req.body?.stream === true) {
      res.setHeader('Content-Type',  'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection',    'keep-alive');
      upstream.body.pipe(res);
    } else {
      const data = await upstream.json();
      res.json(data);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Error en proxy LLM';
    res.status(500).json({ error: msg });
  }
});

export default router;
