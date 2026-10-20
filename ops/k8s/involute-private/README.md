# Involute on Kubernetes — private self-hosted deployment

Kubernetes manifests for a **new, private, self-hosted** Involute deployment:
Postgres 16 + GraphQL API server + nginx web front-end, a one-shot
Redmine → Involute import Job, and an hourly DingTalk organisation sync.

> **Independence.** This deployment is completely independent of any other
> Involute host. It has its own namespace, its own database, its own secrets
> and its own services. It does not read from, write to, or authenticate
> against any other Involute installation.

---

## Contents

| File | Resources |
|---|---|
| `00-namespace.yaml` | Namespace `involute` |
| `10-postgres.yaml` | StatefulSet `involute-db`, Service `involute-db` (5432), PVC `data` (20Gi, storage class `local`) |
| `20-involute-server.yaml` | ConfigMap `involute-config`, Deployment `involute-server` (init container `migrate`), Service `involute-server` (4200), PVC `involute-uploads` (5Gi, storage class `local`) |
| `30-involute-web.yaml` | Deployment `involute-web`, Service `involute-web` (4201) |
| `40-redmine-import-job.yaml` | Job `redmine-import` |
| `45-dingtalk-org-sync-cronjob.yaml` | ConfigMap `involute-dingtalk-org-mapping`, CronJob `dingtalk-org-sync` (hourly) |
| `50-secrets.example.yaml` | Secret **template** — empty placeholders only |

Cluster API version targeted: **k8s 1.16** (`apps/v1`, `batch/v1`, `v1` only).

---

## 1. Prerequisites

* `kubectl` with a context pointing at the target cluster.
* The `local` storage class (provisioner `openebs.io/local`) present in the
  cluster — it is the only storage class available and it is used for the
  Postgres and uploads volumes.
* The three images pushed to Docker Hub and pullable from the cluster:
  * `docker.io/fakechris/involute-server:<tag>`
  * `docker.io/fakechris/involute-web:<tag>`
  * `docker.io/fakechris/involute-cli:<tag>`
* The cluster can reach `https://redmine.91jinrong.com` (the import Job pulls
  the Redmine data over the network).

### Image tags

The manifests are pinned to the build merged in PR #253:

| Image | Tag | Digest |
|---|---|---|
| `docker.io/fakechris/involute-server` | `sha-e524cb9eca96` | `sha256:7279a10c2862de911657765ede1da7a9d58cf36e7f948f88b5a482e44126e347` |
| `docker.io/fakechris/involute-web` | `sha-e524cb9eca96` | `sha256:0cc239dc6bca81d2267dbc8d2a97a94da44bcaf0100d07f26eb207ba42641d1d` |
| `docker.io/fakechris/involute-cli` | `sha-e524cb9eca96` | `sha256:54ea0eda1d72edd43496a20c89d68bbeeab4923fb3f10570239410c2207ad9aa` |

Tags are immutable `sha-<12 hex>` strings, so a rollout always runs a known
build. To roll forward, edit the tag in the four manifests and re-apply:

```bash
cd ops/k8s/involute-private
sed -i '' 's/sha-e524cb9eca96/sha-<new-build>/g' 20-involute-server.yaml 30-involute-web.yaml 40-redmine-import-job.yaml 45-dingtalk-org-sync-cronjob.yaml
```

Never reuse a tag for a different build.

---

## 1a. Sign-in: DingTalk, not Google (INV-1288)

This private deployment signs people in with **DingTalk**. The public
deployment keeps Google. Both run the same code; `AUTH_PROVIDERS` in
`20-involute-server.yaml` decides which lines the sign-in screen offers:

```yaml
- name: AUTH_PROVIDERS
  value: "dingtalk"
```

The DingTalk credentials live in the `involute-dingtalk` Secret
(`appKey`, `appSecret`, `redirectUri`). They come from a **DingTalk
enterprise app** created in the DingTalk console, and the app needs the
contact-read permission so the server can read the person's own profile.

`redirectUri` must be the exact URL registered in the console and must end in
`/auth/dingtalk/callback`, for example
`https://involute.example.internal/auth/dingtalk/callback`.

Sign-in stays invite-only exactly as it is on the Google line: a person is
admitted when a user row already exists for their email, when their email
domain is approved in workspace settings, or when their email is on
`ADMIN_EMAIL_ALLOWLIST`. A DingTalk account with **no email address** cannot
be admitted, and the refusal says so.

---

## 1b. Organisation sync: DingTalk departments → Involute teams (INV-1288)

Sign-in and organisation are two different questions, and the deployment
answers both:

| Question | Answered by |
|---|---|
| *Who is this person?* | The sign-in flow (`/auth/dingtalk/start`). |
| *Who is in the organisation, and where do they sit?* | The organisation import (`involute sync organization --provider dingtalk`). |

The import is a thing of its own — it is not part of sign-in, and it does not
depend on which sign-in line the deployment runs. The source is a parameter:
a second organisation would add a command line and an adapter, not a second
system.

The import turns a DingTalk **department** into an Involute **team** and the
people in that department into its **members**. It runs from a mapping file
that says which department becomes which team:

```json
{
  "departments": [
    {
      "deptId": 1,
      "teamKey": "CORE",
      "teamName": "核心研发",
      "role": "EDITOR",
      "includeSubDepartments": true
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `deptId` | The DingTalk department id. |
| `teamKey` | The Involute team key: 2–10 letters or digits, starting with a letter. It also becomes the identifier prefix (`CORE-12`). |
| `teamName` | Optional; the department name is used when it is absent. |
| `role` | `VIEWER`, `EDITOR` (default) or `OWNER`. |
| `includeSubDepartments` | Optional; when true, the people of the sub-departments join too. |

The mapping lives in the ConfigMap `involute-dingtalk-org-mapping`, so it can
be changed without rebuilding an image:

```bash
kubectl -n involute edit configmap involute-dingtalk-org-mapping
kubectl -n involute create job --from=cronjob/dingtalk-org-sync dingtalk-org-sync-now
kubectl logs -n involute -f job/dingtalk-org-sync-now
```

### What the sync does and does not do

* It **creates** a team when the key is free, and **adopts** an existing team
  that already carries the key. A team it creates gets the same default
  workflow a person-created team gets (Backlog / Ready / In Progress /
  In Review / Done / Canceled), so issues can be filed in it.
* It **refuses** to hand one team to two departments: the second department is
  reported in the warnings and skipped. Give it its own `teamKey`.
* It **refuses** a `teamKey` that a project alias already spells — both spell
  identifiers, and `CORE-12` must not be ambiguous.
* It **never deletes** a person and never deletes a team. Somebody who left a
  department keeps their account, and their membership too, unless the job
  runs with `--prune`.
* `--prune` removes **memberships only** — never accounts. It is deliberately
  **not** set in the manifest.
* A person is matched by **email** (that is how the workspace keys people,
  `docs/permissions.md` §1). The DingTalk `unionId` is recorded alongside, so
  the same person can sign in with DingTalk afterwards. A person with no email
  address is reported in `peopleWithoutEmail`, not dropped in silence.
* Run it with `--dry-run` first: it reports exactly what would change and
  writes nothing.

> **The app needs the personal-information read permission.** Without it
> DingTalk **omits** the `email` field rather than failing, and that person
> cannot be admitted — the workspace keys people by email. Check
> `peopleWithoutEmail` in the job log after the first run.

---

## 2. Fill in the secrets — the one manual step
`50-secrets.example.yaml` contains **empty placeholders only**. It exists to
document the required keys; it must not be committed with real values.

Preferred: create the three Secrets directly from environment variables, so
no secret ever touches a file in the repository:

```bash
cd ops/k8s/involute-private

kubectl create secret generic involute-auth -n involute \
  --from-literal=authToken="$INVOLUTE_AUTH_TOKEN" \
  --from-literal=viewerAssertionSecret="$INVOLUTE_VIEWER_ASSERTION_SECRET" \
  --from-literal=adminEmailAllowlist="$INVOLUTE_ADMIN_EMAIL_ALLOWLIST"

kubectl create secret generic involute-db -n involute \
  --from-literal=postgresPassword="$INVOLUTE_POSTGRES_PASSWORD"

kubectl create secret generic involute-redmine -n involute \
  --from-literal=apiKey="$REDMINE_API_KEY"

kubectl create secret generic involute-dingtalk -n involute \
  --from-literal=appKey="$DINGTALK_APP_KEY" \
  --from-literal=appSecret="$DINGTALK_APP_SECRET" \
  --from-literal=redirectUri="$DINGTALK_REDIRECT_URI"
```

Values to provide:

| Variable | Used by | Notes |
|---|---|---|
| `INVOLUTE_AUTH_TOKEN` | server, CLI import | Agent/API token for this deployment. Generate a random value, e.g. `openssl rand -hex 32`. |
| `INVOLUTE_VIEWER_ASSERTION_SECRET` | server | Secret used to sign viewer assertions. `openssl rand -hex 32`. |
| `INVOLUTE_ADMIN_EMAIL_ALLOWLIST` | server | Optional, comma-separated admin e-mails. May be empty. |
| `INVOLUTE_POSTGRES_PASSWORD` | database, server, CLI | Password of the `involute` Postgres role. |
| `REDMINE_API_KEY` | import Job | Redmine REST API key. **Never hardcode it in a manifest.** |
| `DINGTALK_APP_KEY` | server, org sync | From the DingTalk enterprise app (section 1a). |
| `DINGTALK_APP_SECRET` | server, org sync | From the same app. |
| `DINGTALK_REDIRECT_URI` | server | The callback URL registered in the DingTalk console, ending in `/auth/dingtalk/callback`. Not used by the sync. |

Alternative: copy the template outside the repository, fill it in and apply it
from there — never commit the filled copy:

```bash
cp 50-secrets.example.yaml /tmp/involute-secrets.yaml
# edit /tmp/involute-secrets.yaml, fill in the values
kubectl apply -f /tmp/involute-secrets.yaml
```

If a Secret already exists, `kubectl create secret` fails; use
`kubectl create secret generic ... --dry-run=client -o yaml | kubectl apply -f -`
to update it in place.

---

## 3. Apply

Apply in order — the namespace first, secrets second, workloads last:

```bash
cd ops/k8s/involute-private
kubectl apply -f 00-namespace.yaml
kubectl apply -f /tmp/involute-secrets.yaml     # or the `create secret` calls above
kubectl apply -f 10-postgres.yaml
kubectl apply -f 20-involute-server.yaml
kubectl apply -f 30-involute-web.yaml
```

The whole directory works too, once the Secrets exist — but **exclude the
secret template**, otherwise its empty values would overwrite the real
Secrets:

```bash
kubectl apply -f 00-namespace.yaml -f 10-postgres.yaml -f 20-involute-server.yaml -f 30-involute-web.yaml
```

> Do not run a blanket `kubectl apply -f .` in this directory while
> `50-secrets.example.yaml` is present: it would reset `involute-auth`,
> `involute-db` and `involute-redmine` to empty values and break the
> deployment.

The import Job is **not** part of the default rollout: apply it only when you
want the Redmine data imported (section 5).

The organisation-sync CronJob is also not part of the default rollout: apply
it once the mapping ConfigMap holds the real departments (section 1b).

```bash
kubectl apply -f 45-dingtalk-org-sync-cronjob.yaml
```

### Verify

```bash
kubectl get ns involute
kubectl get pods -n involute
kubectl get svc,statefulset,deploy -n involute
kubectl logs -n involute deploy/involute-server
kubectl logs -n involute pod/involute-db-0
```

`involute-server` starts only after the `migrate` init container has applied
the Prisma migrations (`prisma migrate deploy`) against `involute-db`.

---

## 4. Reach the web app

Both services are `ClusterIP`, so the app is reachable inside the cluster
only. For a quick check, port-forward the web service and open the URL it
prints:

```bash
kubectl port-forward -n involute svc/involute-web 4201:4201
# open http://127.0.0.1:4201
```

The API can be checked the same way:

```bash
kubectl port-forward -n involute svc/involute-server 4200:4200
curl http://127.0.0.1:4200/health
```

For a permanent entry point, add an Ingress for `involute-web` (port 4201) in
front of the `involute-web` Service — no Ingress object is included here
because the cluster's ingress controller is not known:

```yaml
apiVersion: extensions/v1beta1
kind: Ingress
metadata:
  name: involute-web
  namespace: involute
spec:
  rules:
    - host: involute.example.internal
      http:
        paths:
          - path: /
            backend:
              serviceName: involute-web
              servicePort: 4201
```

The API server and the web front-end must share the same public origin. When
you expose the app under a hostname, set that hostname in the ConfigMap
before the rollout:

```bash
kubectl -n involute patch configmap involute-config \
  --type merge -p '{"data":{"APP_ORIGIN":"http://involute.example.internal"}}'
kubectl -n involute rollout restart deploy/involute-server
```

---

## 5. Run (or re-run) the Redmine import

The Job runs three commands in sequence in one container:

1. `import redmine` — export the Redmine team into `/exports`
2. `import --file /exports` — import the snapshot into the Involute database
3. `import verify --file /exports` — verify the import against the export

First run:

```bash
cd ops/k8s/involute-private
kubectl apply -f 40-redmine-import-job.yaml
kubectl logs -n involute -f job/redmine-import
```

A Job cannot be re-run in place (its pod template is immutable), so delete it
and apply the manifest again:

```bash
kubectl delete job redmine-import -n involute
kubectl apply -f 40-redmine-import-job.yaml
kubectl logs -n involute -f job/redmine-import
```

The exported snapshot lives in an `emptyDir` mounted at `/exports` and is
discarded with the pod; copy it out before deleting the Job if the export
files are needed:

```bash
kubectl cp -n involute <pod-name>:/exports ./exports
```

The Job talks to the database directly (`DATABASE_URL`) and to the Redmine
instance over HTTPS (`https://redmine.91jinrong.com`).

---

## 6. Operational notes and limitations

* **Storage class `local` is node-bound.** `involute-db` and
  `involute-uploads` use `ReadWriteOnce` volumes provisioned by
  `openebs.io/local`. They stay on the node that first scheduled them; a
  node failure means the volume does not come back on another node. Keep the
  Postgres StatefulSet at one replica and treat its node as pinned.
* **Google OAuth is disabled** in this deployment: `REQUIRE_GOOGLE_OAUTH=false`
  and the client id/secret/redirect are empty strings.
* **Admin fallback is off** (`ALLOW_ADMIN_FALLBACK=false`); admins come from
  `ADMIN_EMAIL_ALLOWLIST`.
* **Uploads** are stored on the `involute-uploads` PVC at
  `/var/lib/involute/uploads` (5Gi).
* **Image tags are immutable** (`sha-<12 hex>`). Roll forward by editing the
  tag and re-applying; never reuse a tag for a different build.
* The manifests use only `apps/v1`, `batch/v1` and `v1` APIs, so they apply
  unchanged on k8s 1.16.
* **The organisation import is hourly and does not delete anything.** It creates
  teams and memberships, and it writes a DingTalk identity for every person it
  admits, so the sign-in flow and the directory agree on who somebody is.
  `concurrencyPolicy: Forbid` keeps two runs from overlapping.
* **`--prune` is off.** Turn it on in the CronJob's `args` only when the
  membership should follow the directory exactly; it removes memberships
  only, never accounts.
