import type { AccessLinkKind } from "../../shared/auth";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, type ReactNode } from "react";
import {
  api,
  responseJson,
  type SuccessfulResponse,
} from "@/lib/api";

type AuthState = Omit<
  SuccessfulResponse<Awaited<ReturnType<typeof api.api.auth.state.$get>>>,
  "ok"
>;

type AuthContextValue = AuthState & {
  loading: boolean;
  bootstrap: (input: { name: string; email: string }, mock?: boolean) => Promise<void>;
  login: (mock?: boolean) => Promise<void>;
  logout: () => Promise<void>;
  completeAccessLink: (
    kind: AccessLinkKind,
    token: string,
  ) => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const state = useQuery({
    queryKey: ["auth-state"],
    queryFn: async () => {
      const body = await responseJson(await api.api.auth.state.$get());
      return body;
    },
  });

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ["auth-state"] });
  }, [queryClient]);

  const bootstrap = useCallback(
    async (input: { name: string; email: string }, mock = false) => {
      if (mock) {
        await responseJson(
          await api.api.auth.mock.bootstrap.$post({ json: input }),
        );
      } else {
        const options = await responseJson(
          await api.api.auth.bootstrap.options.$post({ json: input }),
        );
        const { startRegistration } = await import("@simplewebauthn/browser");
        const response = await startRegistration({ optionsJSON: options.options });
        await responseJson(
          await api.api.auth.bootstrap.verify.$post({ json: response }),
        );
      }
      await refresh();
    },
    [refresh],
  );

  const login = useCallback(
    async (mock = false) => {
      if (mock) {
        await responseJson(
          await api.api.auth.mock.login.$post({
            json: { userId: "usr_demo_admin" },
          }),
        );
      } else {
        const options = await responseJson(
          await api.api.auth.login.options.$post(),
        );
        const { startAuthentication } = await import("@simplewebauthn/browser");
        const response = await startAuthentication({ optionsJSON: options.options });
        await responseJson(
          await api.api.auth.login.verify.$post({ json: response }),
        );
      }
      await refresh();
    },
    [refresh],
  );

  const logout = useCallback(async () => {
    await responseJson(await api.api.auth.logout.$post());
    queryClient.removeQueries({
      predicate: (query) => query.queryKey[0] !== "auth-state",
    });
    await refresh();
  }, [queryClient, refresh]);

  const completeAccessLink = useCallback(
    async (kind: AccessLinkKind, token: string) => {
      const options = await responseJson(
        kind === "invitation"
          ? await api.api.auth.invitation[":token"].options.$post({
              param: { token },
            })
          : await api.api.auth.recovery[":token"].options.$post({
              param: { token },
            }),
      );
      const { startRegistration } = await import("@simplewebauthn/browser");
      const response = await startRegistration({ optionsJSON: options.options });
      await responseJson(
        kind === "invitation"
          ? await api.api.auth.invitation[":token"].verify.$post({
              param: { token },
              json: response,
            })
          : await api.api.auth.recovery[":token"].verify.$post({
              param: { token },
              json: response,
            }),
      );
      await refresh();
    },
    [refresh],
  );

  const value: AuthContextValue = {
    needsBootstrap: state.data?.needsBootstrap ?? false,
    authenticated: state.data?.authenticated ?? false,
    user: state.data?.user ?? null,
    mockAuthEnabled: state.data?.mockAuthEnabled ?? false,
    loading: state.isLoading,
    bootstrap,
    login,
    logout,
    completeAccessLink,
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
