import type { User } from "./db/schema";

export type SessionUser = Pick<
  User,
  "id" | "name" | "avatarUrl" | "role" | "status"
>;

export type AppEnv = {
  Bindings: Env;
  Variables: {
    user: SessionUser;
  };
};
