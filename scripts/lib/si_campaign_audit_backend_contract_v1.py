"""Audit-only cloud contract; no AWS calls or numerical execution."""
import json
import re

ACCOUNT = '380061838272'
REGION = 'us-east-1'
BUCKET = 'sagemaker-us-east-1-380061838272'
IMAGE = '885854791233.dkr.ecr.us-east-1.amazonaws.com/sagemaker-distribution-prod@sha256:2ae2a90be54895e8ef66b4a26a913c57d1ee52f5429055afe652627ddbfa253a'
ROLE = 'arn:aws:iam::380061838272:role/service-role/AmazonSageMaker-ExecutionRole-20230925T144582'
PREFIX = 'plumenav/mechanism/20260930-campaign-audit-v1-f31137e643c7/'
PRODUCER_JOB = 'plumenav-mech-campaign-v1-20260930-184421'
PRODUCER_INTENT_SHA = '7070543875aac1eba845c9503ad1d99bf395ad09f41711b654bf3c3131cbdf80'
PACKAGE_SHA = 'f31137e643c78728cfe2d157806e547656e585efcbfcf02fe4432e370e697151'
INPUTS = {
    'bootstrap.py': 'd6efccff3e2f00b2e9be570bf7337febc803c4355233e26590852f15211bc0ca',
    'entrypoint.sh': '96f2f7a35afd3c9d4a379ad9ae572796be484f5e896ba4fc752877b2300fe4d6',
    'overlay.tar.gz': '17bb4aaabae6e0d7329ffa564dd50bf785364f06affb13e9b8fd5c08639cd14f',
    'campaign.tar.gz': '8b4094ef09910a19277574d703220e59839da063795e4369487d55c1bcfe53be',
    'wrapper-admission.json': 'b5782d5dc5a0b0c519890aeeaeaf24566e0c4679ff3a2a1e05c56e5b6eac971b',
}
RELEASE_SHA = 'a0416da9dc4c66c61eacf513945c426a13325e87893ccff0a73ccc151a0fca30'
DRIVER_SHA = '2eea6601342214590f74c1bcc43f80152cf1a1edc79c0732e4cfdd0336d8b6b7'
VERIFIER_SHA = '9cbf88f4b037a4aa1a5712143488f62df3d798ffca18439b77f7110a6912cb64'
ENTRY_COMMAND = 'set -e; cd /opt/ml/processing/audit-input; printf "%s %s\\n" "$AUDIT_BACKEND_ENTRYPOINT_SHA256" entrypoint.sh | sha256sum -c -; exec bash entrypoint.sh'
PROVENANCE = {'describe-processing-job.json', 's3-index.json', 'launch-intent.json', 'submission-attempt.json',
              'launch-response.json', 'job-describe-initial.json', 'cloudwatch.json', 'collection-hashes.json', 'transfer-complete.json'}


def need(ok, why):
    if not ok: raise ValueError(why)


def same(a, b):
    return json.dumps(a, sort_keys=True, allow_nan=False) == json.dumps(b, sort_keys=True, allow_nan=False)


def valid_sha(digest):
    return type(digest) is str and re.fullmatch('[0-9a-f]{64}', digest) is not None


def spec_for(job, gate_sha):
    need(type(job) is str and re.fullmatch(r'plumenav-mech-campaign-audit-v1-[0-9]{8}-[0-9]{6}', job)
         and valid_sha(gate_sha), 'Exact audit-only job/gate identity')
    return dict(ProcessingJobName=job, RoleArn=ROLE,
        AppSpecification=dict(ImageUri=IMAGE, ContainerEntrypoint=['bash', '-lc', ENTRY_COMMAND]),
        ProcessingResources=dict(ClusterConfig=dict(InstanceCount=1, InstanceType='ml.m5.12xlarge', VolumeSizeInGB=300)),
        StoppingCondition=dict(MaxRuntimeInSeconds=86400),
        Environment=dict(OPENBLAS_NUM_THREADS='1', OMP_NUM_THREADS='1', MKL_NUM_THREADS='1',
            PYTHONDONTWRITEBYTECODE='1', PYTHONNOUSERSITE='1', MECHANISM_SAVED_CAMPAIGN_AUDIT_APPROVED='YES',
            MECHANISM_CAMPAIGN_APPROVED='NO', MECHANISM_DEVELOPMENT_APPROVED='NO', MECHANISM_INSPECTION_APPROVED='NO',
            AUDIT_BACKEND_BOOTSTRAP_SHA256=INPUTS['bootstrap.py'], AUDIT_BACKEND_ENTRYPOINT_SHA256=INPUTS['entrypoint.sh'],
            AUDIT_BACKEND_OVERLAY_SHA256=INPUTS['overlay.tar.gz'], AUDIT_PRODUCER_TERMINAL_GATE_SHA256=gate_sha),
        ProcessingInputs=[dict(InputName=name, S3Input=dict(S3Uri='s3://' + BUCKET + '/' + PREFIX + folder,
            LocalPath=mount, S3DataType='S3Prefix', S3InputMode='File', S3DataDistributionType='FullyReplicated', S3CompressionType='None'))
            for name, folder, mount in [('audit-input', 'input/', '/opt/ml/processing/audit-input'),
                                       ('producer-admission', 'producer-admission/', '/opt/ml/processing/producer-admission')]],
        ProcessingOutputConfig=dict(Outputs=[dict(OutputName='independent-audit', S3Output=dict(LocalPath='/opt/ml/processing/output',
            S3Uri='s3://' + BUCKET + '/' + PREFIX + 'jobs/' + job + '/output/', S3UploadMode='Continuous'))]))


def validate_intent(d, job, intent_key, controller_sha):
    gate_sha = d['producerTerminalGateSha256']
    need(valid_sha(controller_sha) and valid_sha(gate_sha) and valid_sha(d['producerLedgerSha256'])
         and d['version'] == 'mechanism-campaign-audit-backend-launch-intent-v1'
         and d['kind'] == 'independent-audit-backend' and d['account'] == ACCOUNT and d['region'] == REGION
         and d['controllerSha256'] == controller_sha and d['producerJob'] == PRODUCER_JOB
         and d['producerIntentSha256'] == PRODUCER_INTENT_SHA and d['packageSha256'] == PACKAGE_SHA
         and d['releaseSha256'] == RELEASE_SHA and d['driverSha256'] == DRIVER_SHA
         and d['producerVerifierSha256'] == VERIFIER_SHA
         and same(d['inputHashes'], dict(INPUTS, **{'producer-terminal-gate.json': gate_sha}))
         and same(d['spec'], spec_for(job, gate_sha))
         and intent_key == PREFIX + 'provenance/' + job + '/launch-intent.json', 'Exact pinned audit launch contract')
    need(type(d['histories']) is int and d['histories'] == 2400 and type(d['worlds']) is int and d['worlds'] == 128
         and type(d['resolutionTriplets']) is int and d['resolutionTriplets'] == 240
         and type(d['newMissions']) is int and d['newMissions'] == 0
         and d['authorApprovedAdditionalBudgetUSD'] == 200 and d['allocatedAuditUSD'] == 70
         and d['submitted'] is False and d['automaticRetryAllowed'] is False and d['scientificallyAccepted'] is False,
         'No scope reduction, new missions, unbounded spend or automatic repeats')
    return PREFIX + 'jobs/' + job + '/output/'


def validate_actual(d, actual, job, intent_key, controller_sha, matches):
    prefix = validate_intent(d, job, intent_key, controller_sha)
    need(matches(d['spec'], actual) and same(actual['Environment'], d['spec']['Environment'])
         and not actual['AppSpecification'].get('ContainerArguments')
         and actual['ProcessingJobArn'] == 'arn:aws:sagemaker:' + REGION + ':' + ACCOUNT + ':processing-job/' + job
         and actual['ProcessingJobStatus'] == 'Completed' and not actual.get('FailureReason')
         and actual.get('ProcessingStartTime') and actual.get('ProcessingEndTime'), 'Clean exact terminal auditor job required')
    return prefix


def expected_payloads(index, collector):
    names = {'start.json', 'runtime.json', 'complete.json', 'payload-index.json', 'plan.json', 'source-pins.json',
             'producer-provenance.json', 'producer-terminal-gate.json', 'logs/collection.log', 'logs/producer-preflight.log',
             'logs/independent-audit-driver.log'}
    names |= {'producer-provenance/' + n for n in PROVENANCE}
    names |= {'independent/' + n for n in collector.expected_payloads(index, 'independent-audit') | {collector.LEDGER}}
    need(len(names) == 14427, 'Exact complete nested audit payload set')
    return names
