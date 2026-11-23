import { Client } from "@tmi.js/chat";

import { DelayQueue } from "./queue";

export interface EmoteOffset {
  indices: number[][];
  id: string;
}

export interface EmoteOccurence {
  emoji?: Emote;
  url?: string;
  emote?: Emote;

  start: number;
  end: number;
}

export interface MessagePart {
  content: string;

  emoji?: Emote;
  url?: string;
  emote?: Emote;
}

export interface Badge {
  code: string;
  url: string;
}

export interface Emote {
  code: string;
  url: string;
}

export interface MessageUser {
  id: string;
  login: string;
  displayName: string;
  badges: Badge[];
  color: string;
}

export interface Message {
  id: string;
  date: number;
  user: MessageUser;
  parts: MessagePart[];
}

export interface ManagerOptions {
  prefixUrl: string;

  userId: string;
  userLogin: string;

  queueDelay: number;
  ignoredUsers: string[];

  onMessage(message: Message): void;
  onDeleteMessage(messageId: string): void;
  onTimeout(userId: string): void;
}

export class Manager {
  readonly chatClient: Client;
  readonly queue: DelayQueue<Message>;

  readonly badges = new Map<string, Badge>();
  readonly emotes = new Map<string, Emote>();

  private timeoutId?: number;

  constructor(readonly options: ManagerOptions) {
    this.chatClient = new Client({
      channels: [options.userLogin],
    });

    this.queue = new DelayQueue(options.onMessage);

    this.chatClient.on("moderation", (event) => {
      switch (event.type) {
        case "deleteMessage": {
          this.queue.filter((message) => {
            return message.id !== event.message.id;
          });

          return options.onDeleteMessage(event.message.id);
        }

        case "ban":
        case "timeout": {
          this.queue.filter((message) => {
            return message.user.id !== event.user.id;
          });

          return options.onTimeout(event.user.id);
        }
      }
    });

    this.chatClient.on("message", (event) => {
      const { message, user, tags } = event;

      if (options.ignoredUsers.includes(user.id)) {
        return;
      }

      const line = {
        id: message.id,
        date: tags.tmiSentTs,

        user: {
          id: user.id,
          login: user.login,
          displayName: user.display || user.login,
          color: this.getUserColor(user.id, user.color),
          badges: this.getUserBadges(user.badges),
        },

        parts: this.parseMessage(message.text, message.emotes),
      };

      this.queue.add(line, options.queueDelay);
    });

    this.chatClient.connect();
  }

  close() {
    clearTimeout(this.timeoutId);

    this.chatClient.close();
    this.queue.stop();
  }

  getUserBadges(badges: Map<string, string>) {
    const result = new Array<Badge>();

    for (const item of badges) {
      const badge = this.badges.get(item.join("/"));

      if (badge) {
        result.push(badge);
      }
    }

    return result;
  }

  getUserColor(userId: string, value: string) {
    return value || `#${(Number.parseInt(userId) * 0x41A7) % 0xFFFFFF}`;
  }

  parseMessage(text: string, emoteOffsets: EmoteOffset[]) {
    const occurrences = new Array<EmoteOccurence>();
    const parts = new Array<MessagePart>();

    let lastPosition = 0;

    emoteOffsets.forEach((offset) => {
      offset.indices.forEach((indice) => {
        const start = indice[0];
        const end = indice[1];

        const emote = {
          url: `https://static-cdn.jtvnw.net/emoticons/v2/${offset.id}/default/dark/1.0`,
          code: text.substring(start, end),
        };

        occurrences.push({ emote, start, end });
      });
    });

    this.emotes.forEach((emote, name) => {
      const matches = text.matchAll(
        new RegExp(`(?<!\\S)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\S)`, "g"),
      );

      for (const match of matches) {
        const start = match.index;
        const end = start + name.length;

        occurrences.push({ emote, start, end });
      }
    });

    {
      const matches = text.matchAll(/(?:https?:\/\/)?\S+\.[a-z]+\S*/gi);

      for (const match of matches) {
        const [url] = match;

        const start = match.index;
        const end = start + url.length;

        occurrences.push({ url, start, end });
      }
    }

    {
      const matches = text.matchAll(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{1F1E0}-\u{1F1FF}]/gu);

      for (const match of matches) {
        let [code] = match;

        const start = match.index;
        const end = start + code.length;

        code = Array.from(code, (value) => value.codePointAt(0)?.toString(16)).join("-");

        const emoji = {
          url: `https://cdn.jsdelivr.net/gh/jdecked/twemoji/assets/svg/${code}.svg`,
          code,
        };

        occurrences.push({ emoji, start, end });
      }
    }

    occurrences.sort((a, b) => a.start - b.start);

    for (const occurence of occurrences) {
      if (occurence.start > lastPosition) {
        parts.push({ content: text.substring(lastPosition, occurence.start) });
      }

      parts.push({ ...occurence, content: text.substring(occurence.start, (lastPosition = occurence.end)) });
    }

    if (lastPosition < text.length) {
      parts.push({ content: text.substring(lastPosition) });
    }

    return parts;
  }

  private async refresh() {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
    }

    try {
      const response = await fetch(`${this.options.prefixUrl}/channels/${this.options.userId}`);
      const data = await response.json();

      for (const badge of data.badges) {
        this.badges.set(badge.code, badge);
      }

      for (const emote of data.emotes) {
        this.emotes.set(emote.code, emote);
      }
    } catch {}

    this.timeoutId = setTimeout(() => this.refresh(), 60_000);
  }
}
