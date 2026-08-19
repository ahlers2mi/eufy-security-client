
import { PushClient } from "../client";
import { MessageTag } from "../models";

jest.mock("../../logging", () => ({
    rootPushLogger: { info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn(), trace: jest.fn() },
}));

/*
 * The list of acknowledged message ids is shared with PushService, which writes
 * it to the persistent data. If the client replaced the array instead of
 * emptying it, the service would keep handing FCM the ids it was seeded with at
 * startup - and FCM would deliver every message received since then all over
 * again after a restart.
 */
describe("push/client persistent ids", () => {

    // The login response arms the heartbeat timer; without fake timers the open
    // handle would keep the test run alive.
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    const buildClient = async (): Promise<PushClient> => {
        return await PushClient.init({ androidId: "1234567890", securityToken: "0987654321" });
    };

    const feed = (client: PushClient, tag: MessageTag, object: unknown): void => {
        (client as unknown as { handleParsedMessage: (message: { tag: number; object: unknown }) => void })
            .handleParsedMessage({ tag: tag, object: object });
    };

    it("keeps the array it was given when the login clears the acknowledged ids", async () => {
        const client = await buildClient();
        const shared = ["old-id-1", "old-id-2"];
        client.setPersistentIds(shared);

        feed(client, MessageTag.LoginResponse, {});

        expect(client.getPersistentIds()).toBe(shared);
        expect(shared).toEqual([]);
    });

    it("collects the ids of received messages in that same array", async () => {
        const client = await buildClient();
        const shared: string[] = [];
        client.setPersistentIds(shared);

        feed(client, MessageTag.LoginResponse, {});
        feed(client, MessageTag.DataMessageStanza, { persistentId: "new-id-1", appData: [] });
        feed(client, MessageTag.DataMessageStanza, { persistentId: "new-id-2", appData: [] });

        expect(shared).toEqual(["new-id-1", "new-id-2"]);
    });

    it("caps the list so the persistent data cannot grow without end", async () => {
        const client = await buildClient();
        const shared: string[] = [];
        client.setPersistentIds(shared);

        feed(client, MessageTag.LoginResponse, {});
        for (let i = 0; i < 150; i++) {
            feed(client, MessageTag.DataMessageStanza, { persistentId: `id-${i}`, appData: [] });
        }

        expect(shared.length).toBe(100);
        expect(shared[0]).toBe("id-50");
        expect(shared[99]).toBe("id-149");
    });
});
