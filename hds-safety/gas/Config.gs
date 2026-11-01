/**
 * HDS 안전장부 — 상수와 테이블 스키마 (SPEC.md §5 의 정본).
 * 열 타입: s=문자열, b=불리언, n=숫자, j=JSON(배열·객체). chunk:N 이면 큰 JSON 을 col, col_2 … col_N 열에 나눠 저장.
 */
var APP = {
  name: 'HDS 안전장부',
  version: '1.0.0',
  dbName: 'HDS 안전장부 DB',
  folderName: 'HDS 안전장부 파일',
  tz: 'Asia/Seoul',
  chunkSize: 45000,
  hqSessionDays: 14,
  siteSessionDays: 30,
  lockMs: 20000,
  maxFileBytes: 8 * 1024 * 1024
};

var SCHEMA = {
  sites: { key: 'id', cols: [
    ['id','s'],['name','s'],['type','s'],['region','s'],['client','s'],['address','s'],['tags','j'],['shifts','j'],['forms','j'],
    ['openDate','s'],['status','s'],['hec','b'],['hecLastEval','s'],['hecNextEval','s'],['headcount','n'],
    ['managerName','s'],['managerEmail','s'],['managerPhone','s'],['token','s'],['pinHash','s'],['pinSalt','s'],['memo','s'],
    ['createdAt','s'],['updatedAt','s']
  ]},
  people: { key: 'id', cols: [
    ['id','s'],['site','s'],['name','s'],['job','s'],['role','s'],['phone4','s'],['active','b'],['createdAt','s'],['updatedAt','s']
  ]},
  users: { key: 'id', cols: [
    ['id','s'],['email','s'],['name','s'],['role','s'],['salt','s'],['pwHash','s'],['active','b'],['createdAt','s'],['updatedAt','s'],['lastLoginAt','s']
  ]},
  sessions: { key: 'token', cols: [
    ['token','s'],['kind','s'],['uid','s'],['site','s'],['name','s'],['role','s'],['createdAt','s'],['expiresAt','s']
  ]},
  records: { key: 'id', cols: [
    ['id','s'],['form','s'],['formVersion','s'],['site','s'],['date','s'],['period','s'],['shift','s'],['status','s'],['stageDone','j'],
    ['author','s'],['rev','n'],['createdBy','s'],['requestId','s'],['createdAt','s'],['updatedAt','s'],['submittedAt','s'],
    ['confirmedAt','s'],['confirmedBy','s'],['returnedAt','s'],['returnedBy','s'],['returnNote','s'],['deleted','b'],['deletedReason','s'],
    ['facts','j',{chunk:2}],['data','j',{chunk:8}]
  ]},
  acts: { key: 'id', cols: [
    ['id','s'],['key','s'],['site','s'],['srcId','s'],['srcForm','s'],['srcItem','s'],['title','s'],['detail','s'],['level','s'],['type','s'],
    ['due','s'],['owner','s'],['status','s'],['photoBefore','s'],['photoAfter','s'],['doneAt','s'],['doneBy','s'],['doneNote','s'],
    ['confirmedAt','s'],['confirmedBy','s'],['history','j'],['createdAt','s'],['updatedAt','s'],['deleted','b']
  ]},
  requests: { key: 'id', cols: [
    ['id','s'],['kind','s'],['title','s'],['message','s'],['forms','j'],['sites','j'],['periodKey','s'],['openAt','s'],['due','s'],
    ['attachments','j'],['ackRequired','b'],['remind','j'],['status','s'],['createdBy','s'],['createdAt','s'],['updatedAt','s'],['lastRemindAt','s']
  ]},
  reads: { key: 'id', cols: [
    ['id','s'],['refId','s'],['site','s'],['by','s'],['at','s']
  ]},
  files: { key: 'id', cols: [
    ['id','s'],['site','s'],['recordId','s'],['name','s'],['mime','s'],['size','n'],['driveId','s'],['kind','s'],['createdAt','s'],['createdBy','s']
  ]},
  log: { key: null, cols: [
    ['at','s'],['who','s'],['kind','s'],['ref','s'],['text','s']
  ]},
  kv: { key: 'key', cols: [
    ['key','s'],['value','j']
  ]}
};

var DEFAULT_SETTINGS = {
  company: 'HDS(주) 안전경영지원실',
  appName: 'HDS 안전장부',
  mail: { enabled: true, onRequest: true, onReturn: true, onIncident: true, dailyReminder: true, weeklyDigest: true, hqEmails: [] },
  reminder: { beforeDays: [3, 1], overdue: true, hour: 8 },
  dailyDue: '10:00',
  monthlyDueDay: 5,
  requiredForms: { 'default': ['F07', 'F09', 'F01', 'N1', 'N2', 'N4', 'F08B', 'F10B'], seasonal: { F06: [6, 7, 8, 9] } }
};
