// Workspace HTTP server.
//
// Runs on the user's EC2 (port 9099). Provides:
//   GET  /health     — liveness + instance/bucket info
//   GET  /snapshots  — list this instance's EBS snapshots
//   POST /backup     — create EBS snapshots of every volume attached to this instance
//   POST /restore    — restore a snapshot as a new volume attached to this instance
//
// Env vars injected by user-data (see ../user-data.sh.tftpl):
//   INSTANCE_ID, BUCKET_ID, AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, PORT
import http from "node:http";
import {
  EC2Client,
  AttachVolumeCommand,
  CreateSnapshotCommand,
  CreateVolumeCommand,
  DescribeInstancesCommand,
  DescribeSnapshotsCommand,
  DescribeVolumesCommand,
} from "@aws-sdk/client-ec2";

const PORT = Number(process.env.PORT || 9099);
const INSTANCE_ID = process.env.INSTANCE_ID;
const REGION = process.env.AWS_REGION;
const BUCKET_ID = process.env.BUCKET_ID;

if (!INSTANCE_ID || !REGION) {
  console.error("[workspace] INSTANCE_ID and AWS_REGION are required");
  process.exit(1);
}

const ec2 = new EC2Client({ region: REGION });

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

async function describeSelf() {
  const out = await ec2.send(
    new DescribeInstancesCommand({ InstanceIds: [INSTANCE_ID] })
  );
  const instance = out.Reservations?.[0]?.Instances?.[0];
  if (!instance) throw new Error(`instance ${INSTANCE_ID} not found`);
  return instance;
}

async function listAttachedVolumes() {
  const instance = await describeSelf();
  const mappings = instance.BlockDeviceMappings ?? [];
  return {
    az: instance.Placement?.AvailabilityZone,
    volumes: mappings
      .filter((m) => m.Ebs?.VolumeId)
      .map((m) => ({ device: m.DeviceName, volumeId: m.Ebs.VolumeId })),
  };
}

async function waitForVolumeAvailable(volumeId, timeoutMs = 120_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const out = await ec2.send(
      new DescribeVolumesCommand({ VolumeIds: [volumeId] })
    );
    const state = out.Volumes?.[0]?.State;
    if (state === "available") return;
    if (state === "error") throw new Error(`volume ${volumeId} entered error state`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`volume ${volumeId} did not become available within ${timeoutMs}ms`);
}

const handlers = {
  "GET /health": async () => ({
    ok: true,
    instanceId: INSTANCE_ID,
    bucket: BUCKET_ID,
    region: REGION,
  }),

  "GET /snapshots": async () => {
    const out = await ec2.send(
      new DescribeSnapshotsCommand({
        Filters: [
          { Name: "tag:WorkspaceInstance", Values: [INSTANCE_ID] },
        ],
      })
    );
    return {
      snapshots: (out.Snapshots ?? []).map((s) => ({
        snapshotId: s.SnapshotId,
        volumeId: s.VolumeId,
        state: s.State,
        progress: s.Progress,
        startTime: s.StartTime,
        description: s.Description,
      })),
    };
  },

  "POST /backup": async () => {
    const { volumes } = await listAttachedVolumes();
    const created = [];
    for (const vol of volumes) {
      const result = await ec2.send(
        new CreateSnapshotCommand({
          VolumeId: vol.volumeId,
          Description: `Backup of ${INSTANCE_ID} ${vol.device} @ ${new Date().toISOString()}`,
          TagSpecifications: [
            {
              ResourceType: "snapshot",
              Tags: [
                { Key: "WorkspaceInstance", Value: INSTANCE_ID },
                { Key: "Device", Value: vol.device ?? "unknown" },
              ],
            },
          ],
        })
      );
      created.push({
        device: vol.device,
        volumeId: vol.volumeId,
        snapshotId: result.SnapshotId,
        state: result.State,
      });
    }
    return { ok: true, snapshots: created };
  },

  "POST /restore": async (req) => {
    const body = await readJson(req);
    const snapshotId = String(body.snapshotId ?? "").trim();
    const device = String(body.device ?? "/dev/sdf").trim();
    if (!snapshotId) {
      return { _status: 400, error: "snapshotId is required" };
    }

    const { az } = await listAttachedVolumes();
    if (!az) return { _status: 500, error: "could not resolve availability zone" };

    const created = await ec2.send(
      new CreateVolumeCommand({
        SnapshotId: snapshotId,
        AvailabilityZone: az,
        VolumeType: "gp3",
        TagSpecifications: [
          {
            ResourceType: "volume",
            Tags: [
              { Key: "WorkspaceInstance", Value: INSTANCE_ID },
              { Key: "RestoredFrom", Value: snapshotId },
            ],
          },
        ],
      })
    );

    await waitForVolumeAvailable(created.VolumeId);

    await ec2.send(
      new AttachVolumeCommand({
        VolumeId: created.VolumeId,
        InstanceId: INSTANCE_ID,
        Device: device,
      })
    );

    return {
      ok: true,
      volumeId: created.VolumeId,
      device,
      note: "Volume restored from snapshot and attached. Mount it manually to use the data.",
    };
  },
};

const server = http.createServer(async (req, res) => {
  const key = `${req.method} ${req.url?.split("?")[0]}`;
  const handler = handlers[key];
  if (!handler) return send(res, 404, { error: "not found" });

  try {
    const result = await handler(req);
    const status = typeof result?._status === "number" ? result._status : 200;
    if (result?._status) delete result._status;
    send(res, status, result);
  } catch (err) {
    console.error("[workspace]", key, err);
    send(res, 500, { error: err?.message ?? String(err) });
  }
});

server.listen(PORT, () => {
  console.log(
    `[workspace] listening on :${PORT} instance=${INSTANCE_ID} bucket=${BUCKET_ID} region=${REGION}`
  );
});
