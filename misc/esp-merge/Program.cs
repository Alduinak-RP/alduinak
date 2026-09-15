using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Environments;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Parameters;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Skyrim;
using Noggog;

// Mutagen passes of the r7 AlduinakAdditions.esp merge (reports/r7-esp-merge-plan.md), run through merge.py and masks.py.
//   dotnet run -c Release -- merge --settings <json> --new <padded esp> --new-sha <hex> --r4 <esp> --r4-sha <hex> --attribution <json> --attribution-sha <hex> --removed-navm <txt> --records <n> --out <dir>
//   dotnet run -c Release -- armor-effects --settings <json> --plugin <esp> --plugin-sha <hex> --source <plugin> --effect <hex id> --expect <hex ids> --out <dir>

var opts = new Dictionary<string, string>();
for (int i = 1; i + 1 < args.Length; i += 2) opts[args[i].TrimStart('-')] = args[i + 1];
return (args.Length > 0 ? args[0] : "") switch
{
    "merge" => Merge.Run(opts),
    "armor-effects" => ArmorEffects.Run(opts),
    _ => throw new Exception("usage: merge | armor-effects, see the header of Program.cs"),
};

static class Shared
{
    public static readonly ModKey Self = ModKey.FromNameAndExtension("AlduinakAdditions.esp");
    public const SkyrimRelease Release = SkyrimRelease.SkyrimSE;

    public static void Require(bool ok, string msg)
    {
        if (!ok) throw new Exception("STOP: " + msg);
    }

    public static void CheckSha(string path, string want)
    {
        using var s = File.OpenRead(path);
        var got = Convert.ToHexString(SHA256.HashData(s)).ToLowerInvariant();
        Require(got == want, $"{path}: sha256 {got}, expected {want}");
    }

    // The environment stops before AlduinakAdditions, so the link cache and load order hold only the plugins it overrides
    public static (IGameEnvironment<ISkyrimMod, ISkyrimModGetter> Env, List<ModKey> Order) Environment(string settingsPath)
    {
        var s = JsonNode.Parse(File.ReadAllText(settingsPath))!;
        var order = s["loadOrder"]!.AsArray().Select(n => ModKey.FromNameAndExtension(Path.GetFileName(n!.GetValue<string>()))).ToList();
        var pos = order.IndexOf(Self);
        Require(pos > 0, "AlduinakAdditions.esp is not in the load order");
        var env = GameEnvironment.Typical.Builder<ISkyrimMod, ISkyrimModGetter>(GameRelease.SkyrimSE)
            .WithTargetDataFolder(s["dataDir"]!.GetValue<string>())
            .WithLoadOrder(order.Take(pos).ToArray())
            .Build();
        return (env, order);
    }

    public static string Write(SkyrimMod mod, string outDir, List<ModKey> order)
    {
        Directory.CreateDirectory(outDir);
        var path = Path.Combine(outDir, Self.FileName.String);
        mod.WriteToBinary(path, new BinaryWriteParameters
        {
            MastersListContent = MastersListContentOption.Iterate,
            MastersListOrdering = new MastersListOrderingByLoadOrder(order),
            ModKey = ModKeyOption.NoCheck,
            RecordCount = RecordCountOption.Iterate,
            NextFormID = NextFormIDOption.Iterate,
        });
        return path;
    }

    public static IMajorRecord Dup(IMajorRecordGetter rec, FormKey key)
    {
        var d = ((ISkyrimMajorRecordGetter)rec).Duplicate(key);
        Require(d.GetType() == rec.GetType() || rec.GetType().Name.Contains(d.GetType().Name), $"{rec.FormKey}: duplicate changed type {rec.GetType().Name} -> {d.GetType().Name}");
        return d;
    }

    public static List<ModKey> Masters(string path) =>
        SkyrimMod.CreateFromBinaryOverlay(new ModPath(Self, path), Release).ModHeader.MasterReferences.Select(m => m.Master).ToList();

    public static FormKey Key(string s)
    {
        var i = s.LastIndexOf(':');
        return new FormKey(ModKey.FromNameAndExtension(s[..i]), Convert.ToUInt32(s[(i + 1)..], 16));
    }
}

// Where a record sits in a mutable plugin, so it can be replaced in place
class Slot
{
    public IMajorRecord Rec = null!;
    public Cell? Parent;
    public ExtendedList<IPlaced>? List;
    public IList<Cell>? Cells;
    public Worldspace? World;
    public bool Top;
    public Slot With(IMajorRecord r) => new() { Rec = r, Parent = Parent, List = List, Cells = Cells, World = World, Top = Top };
}

static class Merge
{
    static readonly string[] RekeyActions = { "rekey-r4", "rekey-master", "rekey-new", "rekey-new+restore-master-fields" };

    public static int Run(Dictionary<string, string> o)
    {
        foreach (var k in new[] { "new", "r4", "attribution" }) Shared.CheckSha(o[k], o[k + "-sha"]);
        var (env, order) = Shared.Environment(o["settings"]);
        using var envScope = env;
        var self = Shared.Self;
        var mod = SkyrimMod.CreateFromBinary(new ModPath(self, o["new"]), Shared.Release);
        var r4 = SkyrimMod.CreateFromBinary(new ModPath(self, o["r4"]), Shared.Release);
        var at = JsonNode.Parse(File.ReadAllText(o["attribution"]))!.AsObject();
        var entries = at["entries"]!.AsArray().Select(x => x!.AsObject()).ToList();
        string S(JsonObject e, string k) => e[k]?.GetValue<string>() ?? "";

        // padded NEW: the 8 masters NEW had, then the 6 fillers, so raw index 0x0E is the plugin itself
        var masters = mod.ModHeader.MasterReferences.Select(m => m.Master).ToList();
        var newMasters = at["new_masters"]!.AsArray().Select(x => ModKey.FromNameAndExtension(x!.GetValue<string>())).ToList();
        Shared.Require(masters.Count == 0x0E && masters.Take(newMasters.Count).SequenceEqual(newMasters), $"padded NEW masters {string.Join(", ", masters)}");
        var fillers = masters.Skip(newMasters.Count).ToHashSet();
        var fillerHits = mod.EnumerateFormLinks().Where(l => fillers.Contains(l.FormKey.ModKey)).Select(l => l.FormKey.ToString())
            .Concat(mod.EnumerateMajorRecords().Where(r => fillers.Contains(r.FormKey.ModKey)).Select(r => r.FormKey.ToString())).ToList();
        Shared.Require(fillerHits.Count == 0, $"links or records in the filler masters: {string.Join(", ", fillerHits.Take(10))}");
        Console.WriteLine($"padded NEW: {masters.Count} masters, fillers {string.Join(", ", fillers)} carry no link and no record");
        var records = mod.EnumerateMajorRecords().Count();
        Shared.Require(records == int.Parse(o["records"]), $"Mutagen sees {records} records, esplib {o["records"]}");

        FormKey NewKey(string fid)
        {
            var v = Convert.ToUInt32(fid, 16);
            var idx = (int)(v >> 24);
            Shared.Require(idx < newMasters.Count || idx == 0x0E, $"NEW fid {fid} uses a filler index");
            return new FormKey(idx == 0x0E ? self : masters[idx], v & 0xFFFFFF);
        }
        var r4Masters = r4.ModHeader.MasterReferences.Select(m => m.Master).ToList();
        FormKey R4Key(string fid)
        {
            var v = Convert.ToUInt32(fid.Replace("R4:", ""), 16);
            var idx = (int)(v >> 24);
            Shared.Require(idx <= r4Masters.Count, $"R4 fid {fid} past the master list");
            return new FormKey(idx == r4Masters.Count ? self : r4Masters[idx], v & 0xFFFFFF);
        }

        // NEW space: own ids the CK gave to other plugins' records; R4 space: own ids the CK renumbered
        var newMap = at["rekey_map"]!.AsObject().ToDictionary(kv => Shared.Key(kv.Key), kv => Shared.Key(kv.Value!.GetValue<string>()));
        var r4Map = at["renumber_map_r4_to_new"]!.AsObject().ToDictionary(kv => new FormKey(self, Convert.ToUInt32(kv.Key, 16)), kv => new FormKey(self, Convert.ToUInt32(kv.Value!.GetValue<string>(), 16)));
        Shared.Require(!r4Map.Values.Any(newMap.ContainsKey), "an R4 renumber target is itself re-keyed");
        var rekeys = entries.Where(e => RekeyActions.Contains(S(e, "action"))).ToList();
        Shared.Require(rekeys.Count == newMap.Count, $"{rekeys.Count} re-key entries, rekey_map has {newMap.Count}");

        var plugins = new Dictionary<ModKey, Dictionary<FormKey, IMajorRecordGetter>>();
        IMajorRecordGetter FromPlugin(FormKey key, string plugin)
        {
            var mk = ModKey.FromNameAndExtension(plugin);
            if (!plugins.TryGetValue(mk, out var recs))
            {
                recs = new Dictionary<FormKey, IMajorRecordGetter>();
                foreach (var r in env.LoadOrder[mk].Mod!.EnumerateMajorRecords()) recs.TryAdd(r.FormKey, r);
                plugins[mk] = recs;
            }
            Shared.Require(recs.TryGetValue(key, out var rec), $"{plugin} has no record {key}");
            return rec!;
        }

        // 1. re-key: every re-owned record takes its true FormKey in place, cells after the refs they hold
        var idx = Index(mod);
        foreach (var e in rekeys.OrderBy(e => S(e, "type") == "CELL" ? 1 : 0))
        {
            var from = NewKey(S(e, "fid"));
            var to = Shared.Key(S(e, "target"));
            Shared.Require(from.ModKey == self && newMap.TryGetValue(from, out var mapped) && mapped == to, $"{from}: re-key target {to} disagrees with rekey_map");
            FromPlugin(to, to.ModKey.FileName.String);
            var s = idx[from];
            Replace(mod, idx, from, s.Rec is Cell c ? Rekey(c, to) : Shared.Dup(s.Rec, to));
        }
        idx = Index(mod);
        mod.RemapLinks(newMap);
        Console.WriteLine($"re-keyed {rekeys.Count} records to their true masters and remapped every NEW link through rekey_map ({newMap.Count} ids)");

        // 2. content: R4 for artifact-only records, the master's record, restored master fields, the prior winner's cell data
        var r4idx = Index(r4);
        IMajorRecord FromR4(FormKey r4Key, FormKey outKey)
        {
            var copy = Shared.Dup(r4idx[r4Key].Rec, outKey);
            if (copy is Cell c) ClearChildren(c);
            copy.RemapLinks(r4Map);
            return copy;
        }
        var cityCells = at["city_cells"]!.AsArray().Select(x => x!.AsObject()).ToDictionary(c => S(c, "cell"));
        var done = new Dictionary<string, int>();
        var persistMismatch = new List<string>();
        foreach (var e in entries)
        {
            var act = S(e, "action");
            switch (act)
            {
                case "rekey-r4":
                {
                    var to = Shared.Key(S(e, "target"));
                    Shared.Require(R4Key(S(e, "counterpart")) == to, $"{to}: R4 counterpart {S(e, "counterpart")} is another record");
                    Overwrite(mod, idx, to, FromR4(to, to), persistMismatch);
                    break;
                }
                case "take-r4":
                {
                    var key = NewKey(S(e, "fid"));
                    Overwrite(mod, idx, key, FromR4(R4Key(S(e, "counterpart")), key), persistMismatch);
                    break;
                }
                case "rekey-master":
                {
                    var to = Shared.Key(S(e, "target"));
                    var copy = Shared.Dup(FromPlugin(to, S(e, "master")), to);
                    if (copy is Cell c) ClearChildren(c);
                    Overwrite(mod, idx, to, copy, persistMismatch);
                    break;
                }
                case "rekey-new+restore-master-fields":
                {
                    var to = Shared.Key(S(e, "target"));
                    var fields = e["restore_fields"]!.AsArray().Select(x => x!.GetValue<string>()).ToList();
                    RestoreFields((PlacedObject)idx[to].Rec, (IPlacedObjectGetter)FromPlugin(to, S(e, "master")), fields);
                    Console.WriteLine($"  {to}: NEW content with {string.Join(", ", fields)} restored from {S(e, "master")}");
                    break;
                }
                case "forward-prior":
                {
                    var key = NewKey(S(e, "fid"));
                    var city = cityCells[S(e, "target")];
                    var chain = city["chain"]!.AsArray().Select(x => x!.GetValue<string>()).ToList();
                    Shared.Require(S(city, "decision") == "FORWARD" && chain[^1] == S(city, "prior") && city["graves_fields"]!.AsArray().Count == 0,
                        $"{key}: city review is not a plain forward");
                    SetFields((Cell)idx[key].Rec, FieldsOnly(FromPlugin(key, S(city, "prior")), key));
                    Console.WriteLine($"  forwarded cell {key} {S(e, "edid")} from {S(city, "prior")}; NEW's children kept");
                    break;
                }
                default:
                    continue;
            }
            done[act] = done.GetValueOrDefault(act) + 1;
        }
        Shared.Require(persistMismatch.Count == 0, $"persistence flag disagrees with the ref group: {string.Join("; ", persistMismatch.Take(10))}");

        // 3. restore the R4 records NEW lost, into the cells R4 had them in
        foreach (var e in entries.Where(e => S(e, "action") == "restore-r4"))
        {
            var rk = R4Key(S(e, "fid"));
            Shared.Require(S(e, "src") == "R4" && rk == Shared.Key(S(e, "target")), $"{rk}: restore target {S(e, "target")}");
            Shared.Require(!idx.ContainsKey(rk), $"{rk} is already in the plugin");
            var s = r4idx[rk];
            var parentKey = r4Map.GetValueOrDefault(s.Parent!.FormKey, s.Parent!.FormKey);
            Shared.Require(idx.TryGetValue(parentKey, out var ps) && ps.Rec is Cell, $"{rk}: parent cell {parentKey} is not in the plugin");
            var parent = (Cell)ps!.Rec;
            var copy = Shared.Dup(s.Rec, rk);
            copy.RemapLinks(r4Map);
            if (copy is NavigationMesh nav) { parent.NavigationMeshes.Add(nav); idx[rk] = new Slot { Rec = nav, Parent = parent, World = ps.World }; }
            else
            {
                var list = ReferenceEquals(s.List, s.Parent.Persistent) ? parent.Persistent : parent.Temporary;
                list.Add((IPlaced)copy);
                idx[rk] = new Slot { Rec = copy, Parent = parent, List = list, World = ps.World };
            }
            done["restore-r4"] = done.GetValueOrDefault("restore-r4") + 1;
        }

        // 4. drop the vanilla-geometry NAVM; the broken ref was deleted in step 2a
        foreach (var e in entries.Where(e => S(e, "action") == "drop"))
        {
            var key = NewKey(S(e, "fid"));
            var s = idx[key];
            Shared.Require(s.Rec is NavigationMesh && s.Parent!.NavigationMeshes.Remove((NavigationMesh)s.Rec), $"{key}: not a navmesh in a cell");
            idx.Remove(key);
            done["drop"] = done.GetValueOrDefault("drop") + 1;
        }
        foreach (var (act, n) in done.OrderBy(kv => kv.Key)) Console.WriteLine($"action {act}: {n}");
        var want = entries.GroupBy(e => S(e, "action")).ToDictionary(g => g.Key, g => g.Count());
        foreach (var (act, n) in want.Where(kv => kv.Key is not ("keep" or "delete" or "absent" or "rekey-new")))
            Shared.Require(done.GetValueOrDefault(act) == n, $"action {act}: applied {done.GetValueOrDefault(act)} of {n}");

        Check(mod, entries, o["removed-navm"], records - done.GetValueOrDefault("drop") + done.GetValueOrDefault("restore-r4"), NewKey, R4Key, S, FromPlugin);
        var path = Shared.Write(mod, o["out"], order);
        var written = Shared.Masters(path);
        Console.WriteLine($"wrote {path}; {written.Count} masters:");
        foreach (var (m, i) in written.Select((m, i) => (m, i))) Console.WriteLine($"  {i:X2} {m}");
        var back = SkyrimMod.CreateFromBinaryOverlay(new ModPath(self, path), Shared.Release);
        var keys = back.EnumerateMajorRecords().Select(r => r.FormKey).ToList();
        Shared.Require(keys.Count == keys.Distinct().Count(), "duplicate form keys in the written plugin");
        Console.WriteLine($"read back: {keys.Count} records, next form id {back.ModHeader.Stats.NextFormID:X}");
        return 0;
    }

    static void Check(SkyrimMod mod, List<JsonObject> entries, string removedNavmPath, int wantRecords,
        Func<string, FormKey> newKey, Func<string, FormKey> r4Key, Func<JsonObject, string, string> S, Func<FormKey, string, IMajorRecordGetter> fromPlugin)
    {
        var self = Shared.Self;
        var idx = Index(mod);
        var count = mod.EnumerateMajorRecords().Count();
        Shared.Require(count == wantRecords && idx.Count == count, $"{count} records ({idx.Count} indexed), expected {wantRecords}");
        foreach (var e in entries)
        {
            var act = S(e, "action");
            var target = S(e, "target");
            if (act == "delete") { Shared.Require(!idx.ContainsKey(newKey(S(e, "fid"))), $"{S(e, "fid")} ({S(e, "class")}) should be deleted"); continue; }
            if (act == "drop") continue;
            if (act == "absent") { Shared.Require(!idx.ContainsKey(r4Key(S(e, "fid"))), $"{S(e, "fid")} should be absent"); continue; }
            var key = target != "" ? Shared.Key(target) : newKey(S(e, "fid"));
            Shared.Require(idx.ContainsKey(key), $"{S(e, "type")} {key} ({act}) is missing");
        }

        // r3 navmesh removal and the own interiors (the 5 renumbered cells and the 12 copied interiors included)
        var removed = File.ReadAllLines(removedNavmPath).Where(l => l.Trim().Length > 0).Select(l => Convert.ToUInt32(l.Split(' ')[0], 16) & 0xFFFFFF).ToHashSet();
        Shared.Require(removed.Count == 23, $"removed-navm.txt lists {removed.Count} ids");
        var copied = entries.Where(e => S(e, "src") == "NEW" && S(e, "type") == "CELL" && e["master"] != null).Select(e => Shared.Key(S(e, "target"))).ToHashSet();
        Shared.Require(copied.Count == 12, $"{copied.Count} copied interiors");
        var ownInteriors = idx.Values.Select(s => s.Rec).OfType<Cell>()
            .Where(c => (c.FormKey.ModKey == self || copied.Contains(c.FormKey)) && c.Flags.HasFlag(Cell.Flag.IsInteriorCell)).ToList();
        Shared.Require(copied.All(k => ownInteriors.Any(c => c.FormKey == k)), "a copied interior is missing or not interior");
        var navInOwn = ownInteriors.Where(c => c.NavigationMeshes.Count > 0).Select(c => $"{c.FormKey} {c.EditorID} ({c.NavigationMeshes.Count})").ToList();
        Shared.Require(navInOwn.Count == 0, $"NAVM in own interiors: {string.Join(", ", navInOwn)}");
        var removedBack = idx.Keys.Where(k => k.ModKey == self && removed.Contains(k.ID)).Select(k => $"{idx[k].Rec.GetType().Name} {k}").ToList();
        Shared.Require(removedBack.Count == 0, $"r3 navmesh ids are back: {string.Join(", ", removedBack)}");
        var ownInteriorKeys = ownInteriors.Select(c => c.FormKey).ToHashSet();
        var badNvmi = mod.NavigationMeshInfoMaps.SelectMany(n => n.MapInfos)
            .Where(mi => mi.Parent is NavigationMapInfoCellParent cp && ownInteriorKeys.Contains(cp.ParentCell.FormKey) || mi.NavigationMesh.FormKey.ModKey == self && removed.Contains(mi.NavigationMesh.FormKey.ID))
            .Select(mi => mi.NavigationMesh.FormKey.ToString()).ToList();
        Shared.Require(badNvmi.Count == 0, $"NVMI in own interiors or for r3 ids: {string.Join(", ", badNvmi)}");
        var door = (IPlacedObjectGetter)idx[new FormKey(self, 0x0018BD)].Rec;
        Shared.Require(door.NavigationDoorLink == null, "XNDP is back on 0018BD");
        Console.WriteLine($"navmesh asserts: {ownInteriors.Count} own interiors hold no NAVM, none of the 23 r3 ids exists, no NVMI parent is an own interior, 0018BD has no XNDP");

        var jorrvaskr = (IPlacedObjectGetter)idx[new FormKey(ModKey.FromNameAndExtension("Skyrim.esm"), 0x0CEF0F)].Rec;
        Console.WriteLine($"Jorrvaskr display case 000CEF0F kept as NEW has it: flags {jorrvaskr.MajorRecordFlagsRaw:X8}, XTEL {(jorrvaskr.TeleportDestination != null ? "present" : "none")}");

        // every own link lands on an own record; every link into a non-ESM plugin lands on a record that plugin defines
        var esms = new[] { "Skyrim.esm", "Update.esm", "Dawnguard.esm", "HearthFires.esm", "Dragonborn.esm" }.Select(x => ModKey.FromNameAndExtension(x)).ToHashSet();
        var ownDangling = new List<string>();
        var modDangling = new List<string>();
        foreach (var l in mod.EnumerateFormLinks())
        {
            var k = l.FormKey;
            if (k.IsNull) continue;
            if (k.ModKey == self) { if (!idx.ContainsKey(k)) ownDangling.Add(k.ToString()); continue; }
            if (esms.Contains(k.ModKey) || idx.ContainsKey(k)) continue;
            try { fromPlugin(k, k.ModKey.FileName.String); }
            catch (Exception) { modDangling.Add(k.ToString()); }
        }
        Shared.Require(ownDangling.Count == 0, $"{ownDangling.Count} own links dangle: {string.Join(", ", ownDangling.Distinct().Take(20))}");
        Shared.Require(modDangling.Count == 0, $"{modDangling.Count} links into plugins dangle: {string.Join(", ", modDangling.Distinct().Take(20))}");
        Console.WriteLine($"links: no own link and no link into a non-ESM plugin dangles; {count} records");
    }

    public static Dictionary<FormKey, Slot> Index(SkyrimMod mod)
    {
        var d = new Dictionary<FormKey, Slot>();
        void Add(Slot s) => Shared.Require(d.TryAdd(s.Rec.FormKey, s), $"{s.Rec.FormKey} appears twice");
        void AddCell(Cell c, IList<Cell>? holder, Worldspace? w)
        {
            Add(new Slot { Rec = c, Cells = holder, World = w });
            foreach (var p in c.Persistent) Add(new Slot { Rec = p, Parent = c, List = c.Persistent, World = w });
            foreach (var p in c.Temporary) Add(new Slot { Rec = p, Parent = c, List = c.Temporary, World = w });
            foreach (var n in c.NavigationMeshes) Add(new Slot { Rec = n, Parent = c, World = w });
            if (c.Landscape != null) Add(new Slot { Rec = c.Landscape, Parent = c, World = w });
        }
        foreach (var b in mod.Cells.Records) foreach (var sb in b.SubBlocks) foreach (var c in sb.Cells) AddCell(c, sb.Cells, null);
        foreach (var w in mod.Worldspaces.Records)
        {
            Add(new Slot { Rec = w, Top = true });
            if (w.TopCell != null) AddCell(w.TopCell, null, w);
            foreach (var b in w.SubCells) foreach (var sb in b.Items) foreach (var c in sb.Items) AddCell(c, sb.Items, w);
        }
        foreach (var r in mod.EnumerateMajorRecords()) if (!d.ContainsKey(r.FormKey)) d[r.FormKey] = new Slot { Rec = r, Top = true };
        return d;
    }

    static int RefIndex<T>(IList<T> list, T item) where T : class
    {
        for (int i = 0; i < list.Count; i++) if (ReferenceEquals(list[i], item)) return i;
        throw new Exception("record not found in its container");
    }

    static void Replace(SkyrimMod mod, Dictionary<FormKey, Slot> idx, FormKey key, IMajorRecord repl)
    {
        var s = idx[key];
        switch (s.Rec)
        {
            case Cell c when s.Cells != null: s.Cells[RefIndex(s.Cells, c)] = (Cell)repl; break;
            case Cell when s.World != null: s.World.TopCell = (Cell)repl; break;
            case IPlaced p when s.List != null: s.List[RefIndex<IPlaced>(s.List, p)] = (IPlaced)repl; break;
            case NavigationMesh n when s.Parent != null: s.Parent.NavigationMeshes[RefIndex<NavigationMesh>(s.Parent.NavigationMeshes, n)] = (NavigationMesh)repl; break;
            case Landscape when s.Parent != null: s.Parent.Landscape = (Landscape)repl; break;
            default:
                Shared.Require(s.Top, $"{key}: no container");
                TopGroup(mod, s.Rec, remove: true);
                TopGroup(mod, repl, remove: false);
                break;
        }
        idx.Remove(key);
        Shared.Require(idx.TryAdd(repl.FormKey, s.With(repl)), $"{repl.FormKey} already in the plugin");
    }

    static void TopGroup(SkyrimMod mod, IMajorRecord r, bool remove)
    {
        switch (r)
        {
            case ConstructibleObject x: if (remove) Shared.Require(mod.ConstructibleObjects.Remove(x.FormKey), $"{x.FormKey} not removed"); else mod.ConstructibleObjects.Set(x); break;
            case Mutagen.Bethesda.Skyrim.Activator x: if (remove) Shared.Require(mod.Activators.Remove(x.FormKey), $"{x.FormKey} not removed"); else mod.Activators.Set(x); break;
            case Furniture x: if (remove) Shared.Require(mod.Furniture.Remove(x.FormKey), $"{x.FormKey} not removed"); else mod.Furniture.Set(x); break;
            case NavigationMeshInfoMap x: if (remove) Shared.Require(mod.NavigationMeshInfoMaps.Remove(x.FormKey), $"{x.FormKey} not removed"); else mod.NavigationMeshInfoMaps.Set(x); break;
            default: throw new Exception($"top-level {r.GetType().Name} {r.FormKey} is not handled");
        }
    }

    static void Overwrite(SkyrimMod mod, Dictionary<FormKey, Slot> idx, FormKey key, IMajorRecord content, List<string> persistMismatch)
    {
        var s = idx[key];
        if (s.Rec is Cell target) { SetFields(target, (Cell)content); return; }
        if (s.List != null && (((IMajorRecordGetter)content).MajorRecordFlagsRaw & 0x400) != 0 != ReferenceEquals(s.List, s.Parent!.Persistent))
            persistMismatch.Add(key.ToString());
        Replace(mod, idx, key, content);
    }

    static void ClearChildren(Cell c)
    {
        c.Persistent.Clear();
        c.Temporary.Clear();
        c.NavigationMeshes.Clear();
        c.Landscape = null;
    }

    static Cell FieldsOnly(IMajorRecordGetter src, FormKey key)
    {
        var c = (Cell)Shared.Dup(src, key);
        ClearChildren(c);
        return c;
    }

    // A re-keyed cell keeps the same child objects, so edits made to them before and after stay with it
    static Cell Rekey(Cell c, FormKey key)
    {
        var n = FieldsOnly(c, key);
        n.Persistent.AddRange(c.Persistent);
        n.Temporary.AddRange(c.Temporary);
        n.NavigationMeshes.AddRange(c.NavigationMeshes);
        n.Landscape = c.Landscape;
        return n;
    }

    static void SetFields(Cell target, Cell fields)
    {
        Shared.Require(fields.Persistent.Count + fields.Temporary.Count + fields.NavigationMeshes.Count == 0 && fields.Landscape == null, $"{target.FormKey}: field source has children");
        var (p, t, n, l) = (target.Persistent.ToList(), target.Temporary.ToList(), target.NavigationMeshes.ToList(), target.Landscape);
        var g = (target.Timestamp, target.UnknownGroupData, target.PersistentTimestamp, target.PersistentUnknownGroupData, target.TemporaryTimestamp, target.TemporaryUnknownGroupData);
        ((IMajorRecordInternal)target).DeepCopyIn(fields);
        target.Persistent.SetTo(p);
        target.Temporary.SetTo(t);
        target.NavigationMeshes.SetTo(n);
        target.Landscape = l;
        (target.Timestamp, target.UnknownGroupData, target.PersistentTimestamp, target.PersistentUnknownGroupData, target.TemporaryTimestamp, target.TemporaryUnknownGroupData) = g;
        Shared.Require(target.EditorID == fields.EditorID && target.Location.FormKeyNullable == fields.Location.FormKeyNullable && target.Flags == fields.Flags, $"{target.FormKey}: cell fields not copied");
    }

    static void RestoreFields(PlacedObject target, IPlacedObjectGetter master, List<string> fields)
    {
        foreach (var f in fields)
        {
            switch (f)
            {
                case "XTEL": target.TeleportDestination = master.TeleportDestination?.DeepCopy(); break;
                case "XNDP": target.NavigationDoorLink = master.NavigationDoorLink?.DeepCopy(); break;
                case "XOWN": target.Owner.SetTo(master.Owner.FormKeyNullable); break;
                case "VMAD": target.VirtualMachineAdapter = master.VirtualMachineAdapter?.DeepCopy(); break;
                case "XLKR": target.LinkedReferences.SetTo(master.LinkedReferences.Select(x => x.DeepCopy())); break;
                default: throw new Exception($"{target.FormKey}: restoring {f} is not implemented");
            }
        }
    }
}

static class ArmorEffects
{
    // Strips the enchantment from the crafted ARMO of one plugin; the master list must not change
    public static int Run(Dictionary<string, string> o)
    {
        Shared.CheckSha(o["plugin"], o["plugin-sha"]);
        var (env, order) = Shared.Environment(o["settings"]);
        using var envScope = env;
        var mod = SkyrimMod.CreateFromBinary(new ModPath(Shared.Self, o["plugin"]), Shared.Release);
        var before = mod.ModHeader.MasterReferences.Select(m => m.Master).ToList();
        var src = ModKey.FromNameAndExtension(o["source"]);
        var effect = new FormKey(src, Convert.ToUInt32(o["effect"], 16));
        var expect = o["expect"].Split(',').Select(x => Convert.ToUInt32(x, 16)).ToHashSet();
        Shared.Require(before.Contains(src), $"{src} is not a master of the plugin");

        var winners = env.LoadOrder.PriorityOrder.ConstructibleObject().WinningOverrides().ToDictionary(c => c.FormKey, c => c);
        foreach (var c in mod.ConstructibleObjects) winners[c.FormKey] = c;
        var crafted = winners.Values.Select(c => c.CreatedObject.FormKey).ToHashSet();
        var targets = env.LoadOrder[src].Mod!.Armors.Where(a => a.FormKey.ModKey == src && !a.ObjectEffect.IsNull && crafted.Contains(a.FormKey)).ToList();
        Shared.Require(targets.Select(a => a.FormKey.ID).ToHashSet().SetEquals(expect), $"crafted enchanted ARMO in {src}: {string.Join(", ", targets.Select(a => a.FormKey))}");
        foreach (var a in targets)
        {
            var carriers = env.LoadOrder.ListedOrder.Where(l => l.Mod != null && l.Mod.Armors.ContainsKey(a.FormKey)).Select(l => l.ModKey).ToList();
            Shared.Require(carriers.SequenceEqual(new[] { src }) && !mod.Armors.ContainsKey(a.FormKey), $"{a.FormKey} is overridden by {string.Join(", ", carriers)} or already by the plugin");
            Shared.Require(a.ObjectEffect.FormKey == effect, $"{a.FormKey} carries {a.ObjectEffect.FormKey}, not {effect}");
            var ovr = mod.Armors.GetOrAddAsOverride(a);
            ovr.ObjectEffect.Clear();
            Console.WriteLine($"  {a.FormKey} {a.EditorID}: EITM {effect} removed; value {ovr.Value}, rating {ovr.ArmorRating}, weight {ovr.Weight}");
        }
        var path = Shared.Write(mod, o["out"], order);
        var after = Shared.Masters(path);
        Shared.Require(after.SequenceEqual(before), $"master list changed: {string.Join(", ", after)}");
        Console.WriteLine($"wrote {path}; {targets.Count} ARMO overrides, master list unchanged ({after.Count})");
        return 0;
    }
}
