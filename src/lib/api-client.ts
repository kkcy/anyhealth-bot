// Typed Elysia API client. Every bot tool / lib that previously hit Supabase
// goes through here. Auth = bot bearer key; per-caller phone header is added
// via apiWithPhone() for endpoints that need it (bookings, optouts, etc.).
import createClient, { type Client } from "openapi-fetch";
import type { paths } from "./api-types";

function requireKey(): string {
	const apiKey = process.env.ANYHEALTH_BOT_API_KEY;
	if (!apiKey) {
		throw new Error(
			"ANYHEALTH_BOT_API_KEY missing — set it in .env.local before booting the bot",
		);
	}
	return apiKey;
}

function baseUrl(): string {
	return process.env.ANYHEALTH_API_URL ?? "http://localhost:3000";
}

let cached: Client<paths> | null = null;

export function api(): Client<paths> {
	if (!cached) {
		cached = createClient<paths>({
			baseUrl: baseUrl(),
			headers: { Authorization: `Bearer ${requireKey()}` },
		});
	}
	return cached;
}

export function apiWithPhone(phone: string): Client<paths> {
	return createClient<paths>({
		baseUrl: baseUrl(),
		headers: {
			Authorization: `Bearer ${requireKey()}`,
			"X-Bot-Phone": phone,
		},
	});
}

export type Api = ReturnType<typeof api>;
