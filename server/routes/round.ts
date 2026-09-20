import { Router } from 'express';
import { LADDER, type GuessRequest, type GuessResponse, type RoundResponse } from '@shared/types.ts';
import { getTrackDetail, spotifyConfigured } from '../spotify.ts';
import { getContext, getRound, startRound, advance } from '../store.ts';

export const roundRouter = Router();

roundRouter.post('/round', (req, res) => {
  const { contextId } = req.body as { contextId?: string };
  const ctx = contextId ? getContext(contextId, req.session.id) : undefined;
  if (!ctx) {
    res.status(404).json({ error: 'unknown context — build one first' });
    return;
  }
  const round = startRound(ctx);
  // The answer stays server-side; the client only ever holds an opaque token.
  const body: RoundResponse = { roundToken: round.token, ladder: LADDER };
  res.json(body);
});

roundRouter.post('/round/:token/guess', async (req, res) => {
  const round = getRound(req.params.token, req.session.id);
  if (!round) {
    res.status(404).json({ error: 'unknown round' });
    return;
  }
  if (round.over) {
    res.status(409).json({ error: 'round is already over' });
    return;
  }

  const { trackId } = req.body as GuessRequest;
  const correct = trackId !== null && trackId === round.answer.id;
  if (correct) round.over = true;
  else advance(round);

  // Playlist tracks carry only the playlist cover until the answer is revealed;
  // fetching real album art for one track is cheap and only happens once per round.
  if (round.over) {
    const ctx = getContext(round.contextId, req.session.id);
    const spotifyId = ctx?.spotifyIds.get(round.answer.id);
    if (spotifyId && spotifyConfigured() && !round.answer.album) {
      const detail = await getTrackDetail(spotifyId);
      if (detail) {
        round.answer = {
          ...round.answer,
          album: detail.album,
          artworkUrl: detail.artworkUrl ?? round.answer.artworkUrl,
        };
      }
    }
  }

  const body: GuessResponse = {
    correct,
    rung: round.rung,
    over: round.over,
    ...(round.over ? { answer: round.answer } : {}),
  };
  res.json(body);
});
