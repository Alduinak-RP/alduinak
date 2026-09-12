import { DiscordGuildConfig, Settings } from "../settings";
import { System, SystemContext } from "./system";
import { Client, GatewayIntentBits, GuildMember, PartialGuildMember } from "discord.js";
import { kickWithReason } from "./kickUtil";

type Mp = any; // TODO

const BAN_KICK_REASON = "You were banned from the Discord server.";

export const hasDiscordBanRole = (guildConfig: DiscordGuildConfig, roleIds: string[]): boolean =>
    !!guildConfig.banRoleId && roleIds.includes(guildConfig.banRoleId);

// Discord ban role or guild ban: kick every connection of that Discord account (client closes the game) and disable its characters
export class DiscordBanSystem implements System {
    systemName = "DiscordBanSystem";

    // userId -> Discord id of the login, covers players still in character select
    private discordIdByUser = new Map<number, string>();

    disconnect(userId: number): void {
        this.discordIdByUser.delete(userId);
    }

    async initAsync(ctx: SystemContext): Promise<void> {
        ctx.gm.on("spawnAllowed", (userId: number, _profileId: number, _roles: string[], discordId?: string) => {
            if (discordId) this.discordIdByUser.set(userId, String(discordId));
            else this.discordIdByUser.delete(userId);
        });

        const settingsObject = await Settings.get();

        const discordAuth = settingsObject.discordAuth;

        if (settingsObject.offlineMode) {
            return console.log("discord ban system is disabled due to offline mode");
        }
        if (!discordAuth) {
            return console.warn("discordAuth is missing, skipping Discord ban system");
        }
        if (!discordAuth.botToken) {
            return console.warn("discordAuth.botToken is missing, skipping Discord ban system");
        }
        if (!discordAuth.guilds || discordAuth.guilds.length === 0) {
            return console.warn("discordAuth.guilds array is empty or missing, skipping Discord ban system");
        }

        const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildModeration] });

        client.on("error", (error) => {
            console.error(error);
        });

        client.on("warn", (message) => {
            console.warn(message);
        });

        const isBanned = (member: GuildMember | PartialGuildMember): boolean => {
            const guildConfig = discordAuth.guilds.find(g => g.guildId === member.guild.id);
            return !!guildConfig && hasDiscordBanRole(guildConfig, [...member.roles.cache.keys()]);
        };

        client.on("guildMemberUpdate", (oldMember, newMember) => {
            if (!isBanned(newMember)) return;
            if (!oldMember.partial && isBanned(oldMember)) return;
            this.banDiscordAccount(ctx, newMember.id, `ban role on guild ${newMember.guild.id}`);
        });

        // An uncached member's first update arrives here instead of guildMemberUpdate
        client.on("guildMemberAvailable", (member) => {
            if (isBanned(member)) this.banDiscordAccount(ctx, member.id, `ban role on guild ${member.guild.id}`);
        });

        client.on("guildBanAdd", (ban) => {
            if (!discordAuth.guilds.some(g => g.guildId === ban.guild.id)) return;
            this.banDiscordAccount(ctx, ban.user.id, `guild ban on ${ban.guild.id}`);
        });

        try {
            await client.login(discordAuth.botToken);
        } catch (e) {
            return console.error(`Error logging in Discord client: ${e}`);
        }
    }

    private banDiscordAccount(ctx: SystemContext, discordId: string, why: string): void {
        const mp = ctx.svr as unknown as Mp;

        const userIds = new Set<number>();
        this.discordIdByUser.forEach((id, userId) => { if (id === discordId) userIds.add(userId); });

        let actorIds: number[] = [];
        try { actorIds = mp.findFormsByPropertyValue("private.indexed.discordId", discordId) as number[]; } catch { }
        for (const actorId of actorIds) {
            const userId = ctx.svr.getUserByActor(actorId);
            if (userId >= 0 && userId < 0xffff && ctx.svr.getUserActor(userId) === actorId) userIds.add(userId);
        }

        console.log(`DiscordBanSystem: ${why} for ${discordId}, kicking users [${[...userIds].join(", ")}], disabling actors [${actorIds.map(a => a.toString(16)).join(", ")}]`);

        userIds.forEach(userId => {
            if (!ctx.svr.isConnected(userId)) return;
            try { kickWithReason(mp, userId, BAN_KICK_REASON); } catch { }
        });
        actorIds.forEach(actorId => {
            try { ctx.svr.setEnabled(actorId, false); } catch { }
        });
    }
}
