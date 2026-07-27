import { Router } from "express";
import { z } from "zod";
import { findOrCreateUserByEmail, findUserById } from "../persistence/repositories/userRepository";
import { apiErrorHandler } from "./errorHandler";

// Mounted at /users (not /workflows) -- see api/app.ts.
export const usersRouter = Router();

const createUserSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
});

// POST /users -- Phase 10: find-or-create by email, a stopgap for user
// identity ahead of real authentication (a later phase). The frontend calls
// this once (prompting for name/email), then reuses the returned id from
// localStorage -- see frontend/src/state/currentUser.ts. This endpoint is
// meant to be replaced wholesale once real auth exists, not built on top of.
usersRouter.post("/", async (req, res, next) => {
  try {
    const body = createUserSchema.parse(req.body);
    const user = await findOrCreateUserByEmail(body);
    res.status(200).json(user);
  } catch (err) {
    next(err);
  }
});

// GET /users/:id -- Phase 16 item 7: lets the frontend confirm a
// localStorage-remembered user still exists (e.g. after test data was
// cleaned up server-side) before trusting it for a new action, instead of
// only finding out via a cryptic foreign-key failure once it tries to create
// a workflow.
usersRouter.get("/:id", async (req, res, next) => {
  try {
    const user = await findUserById(req.params.id);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.json(user);
  } catch (err) {
    next(err);
  }
});

usersRouter.use(apiErrorHandler);
