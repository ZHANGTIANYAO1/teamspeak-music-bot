import { isAxiosError } from "axios";

/** Axios errors can include music-account cookies in the message or config. */
export function musicRequestError(error: unknown): Error {
  if (isAxiosError(error)) {
    const status = error.response?.status;
    return new Error(typeof status === "number" ? `Music service request failed (HTTP ${status})` : "Music service request failed");
  }
  return error instanceof Error ? error : new Error("Music service request failed");
}
