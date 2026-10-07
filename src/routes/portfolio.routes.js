const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { nanoid } = require('nanoid');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { UPLOADS_DIR, verifyImageMagicBytes, verifyVideoMagicBytes } = require('../uploads');

const router = express.Router();

const MAX_PHOTOS_PER_PROVIDER = 12;
// v80: 12MB. A photo straight off a modern phone is often 5 to 12MB, and
// the old 5MB limit turned those away. The page now shrinks photos before
// sending; this is the ceiling for a browser that couldn't.
const MAX_FILE_SIZE_BYTES = 12 * 1024 * 1024;
const uploadErrorMessage = (err, limitMb) => err && err.code === 'LIMIT_FILE_SIZE'
  ? `That file is too big. The limit is ${limitMb}MB.`
  : /heic|heif/i.test((err && err.message) || '') ? 'That photo is in HEIC format, which we can\'t use. Save it as JPEG first, or take a new photo.'
  : ((err && err.message) || 'Upload failed');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${req.user.sub}_${nanoid(12)}${ext}`);
  },
});

function fileFilter(req, file, cb) {
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (!allowed.includes(file.mimetype)) {
    return cb(new Error('Only JPEG, PNG, WEBP, or GIF images are allowed'));
  }
  cb(null, true);
}

const upload = multer({ storage, fileFilter, limits: { fileSize: MAX_FILE_SIZE_BYTES } });

// ── JOB/BOOKING PHOTOS ───────────────────────────────────────────────────
// Lets a customer show a provider what the job actually looks like before
// that provider decides whether to accept — the same real-world pattern
// TaskRabbit, Thumbtack, and Handy all use. These are NOT public: they
// attach to one specific job posting or booking and are only ever
// returned by the already-scoped endpoints that show that job/contract to
// its actual customer, matched/booked provider, or an admin — never a
// public listing, never another customer's or provider's view. See the
// privacy note surfaced in the upload UI itself, not just buried in a
// terms-of-service page nobody reads.
const MAX_JOB_PHOTOS = 5;
const MAX_JOB_MEDIA_SIZE_BYTES = 50 * 1024 * 1024; // 50MB — video files are a lot bigger than photos, hence a separate, larger limit that only applies here, not to profile/portfolio photo uploads
const jobPhotoStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `jobphoto_${req.user.sub}_${nanoid(12)}${ext}`);
  },
});
// A customer showing a provider what the job actually looks like isn't
// always well-served by a still photo — a short video of a leaking pipe
// or a strange noise a machine is making often explains the job far
// better than any picture could. Images plus the three common video
// formats browsers can record/export directly (MP4, MOV, WebM).
function jobMediaFileFilter(req, file, cb) {
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/quicktime', 'video/webm'];
  if (!allowed.includes(file.mimetype)) {
    return cb(new Error('Only JPEG, PNG, WEBP, GIF images or MP4, MOV, WEBM videos are allowed'));
  }
  cb(null, true);
}
const uploadJobPhoto = multer({ storage: jobPhotoStorage, fileFilter: jobMediaFileFilter, limits: { fileSize: MAX_JOB_MEDIA_SIZE_BYTES } });

// POST /api/job-photos/upload — customer only. Uploads ONE photo and
// returns its URL; the frontend collects however many URLs (up to
// MAX_JOB_PHOTOS) and includes them when actually posting the job or
// creating the booking — the same "upload first, reference by URL after"
// pattern already used for profile photos, so posting a job doesn't need
// to also be a file-upload request.
router.post('/job-photos/upload', requireAuth, requireRole('customer'), (req, res) => {
  uploadJobPhoto.single('photo')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: uploadErrorMessage(err, 50) });
    if (!req.file) return res.status(400).json({ error: 'No photo was provided' });

    if (!fs.existsSync(req.file.path)) {
      console.error(`Job photo upload reported success but file is missing at ${req.file.path} — check UPLOADS_DIR points to a writable, persistent location.`);
      return res.status(500).json({ error: 'The file could not be saved to disk. Please try again.' });
    }
    const isVideo = req.file.mimetype.startsWith('video/');
    const verified = isVideo
      ? verifyVideoMagicBytes(req.file.path, req.file.mimetype)
      : verifyImageMagicBytes(req.file.path, req.file.mimetype);
    if (!verified) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: `This file does not appear to be a genuine ${isVideo ? 'video' : 'image'} — please upload a real ${isVideo ? 'video' : 'photo'}.` });
    }

    res.status(201).json({ url: `/uploads/${req.file.filename}`, isVideo });
  });
});

// GET /api/portfolio/mine — the logged-in provider's own photos
router.get('/portfolio/mine', requireAuth, requireRole('provider'), async (req, res) => {
  const photos = await db.filter('portfolioPhotos', p => p.providerId === req.user.sub);
  res.json({ photos });
});

// POST /api/portfolio/upload — real file upload, saved to real disk
router.post('/portfolio/upload', requireAuth, requireRole('provider'), (req, res) => {
  upload.single('photo')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: uploadErrorMessage(err, 12) });
    }
    if (!req.file) return res.status(400).json({ error: 'No photo file was provided' });

    // Confirm the file actually landed where we expect before doing anything
    // else — silently reporting success on a write that didn't really stick
    // is exactly the failure mode that's hardest to notice until a user
    // reports a vanished photo days later.
    if (!fs.existsSync(req.file.path)) {
      console.error(`Portfolio upload reported success but file is missing at ${req.file.path} — check that UPLOADS_DIR points to a writable, persistent location.`);
      return res.status(500).json({ error: 'The photo could not be saved to disk. Please try again, or contact support if this keeps happening.' });
    }

    // The mimetype check above only looked at what the uploader CLAIMED
    // the file was — trivially spoofable by anyone crafting the request
    // directly rather than going through a real browser file picker. This
    // checks the actual bytes now on disk against a real signature for
    // that image format, and rejects (deleting the file) if they don't
    // match — the same technique real image-processing libraries use to
    // identify a file, not trusting what the upload claimed about itself.
    if (!verifyImageMagicBytes(req.file.path, req.file.mimetype)) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'This file does not appear to be a genuine image — please upload a real photo.' });
    }

    const existing = await db.filter('portfolioPhotos', p => p.providerId === req.user.sub);
    if (existing.length >= MAX_PHOTOS_PER_PROVIDER) {
      fs.unlink(req.file.path, () => {}); // clean up the file we just saved, since we're rejecting it
      return res.status(400).json({ error: `You can have at most ${MAX_PHOTOS_PER_PROVIDER} portfolio photos — remove one first` });
    }

    const photo = {
      id: `pf_${nanoid(10)}`,
      providerId: req.user.sub,
      filename: req.file.filename,
      url: `/uploads/${req.file.filename}`,
      createdAt: new Date().toISOString(),
    };
    await db.insert('portfolioPhotos', photo);

    // Verify the record genuinely round-trips back out of the datastore
    // before telling the client it worked — same principle as the file
    // check above, applied to the database side of the same operation.
    const confirmed = await db.find('portfolioPhotos', p => p.id === photo.id);
    if (!confirmed) {
      fs.unlink(req.file.path, () => {});
      console.error(`Portfolio photo record ${photo.id} did not persist after insert.`);
      return res.status(500).json({ error: 'The photo upload could not be saved. Please try again.' });
    }

    res.status(201).json({ photo: confirmed });
  });
});

// DELETE /api/portfolio/:id — remove one of the provider's own photos
router.delete('/portfolio/:id', requireAuth, requireRole('provider'), async (req, res) => {
  const photo = await db.find('portfolioPhotos', p => p.id === req.params.id && p.providerId === req.user.sub);
  if (!photo) return res.status(404).json({ error: 'Photo not found' });
  await db.remove('portfolioPhotos', photo.id);
  const filePath = path.join(UPLOADS_DIR, photo.filename);
  fs.unlink(filePath, () => {}); // best-effort; a missing file shouldn't fail the request
  res.json({ ok: true });
});

// ── PROFILE PHOTO ────────────────────────────────────────────────────────
// A single photo identifying the person themselves — distinct from the
// portfolio (multiple work-sample photos). Available to any signed-in
// account, not just providers: a customer's profile photo is just as real
// as a provider's, even though providers are the ones shown on public
// cards today. Uploading a new one replaces the old one (and deletes the
// old file), rather than accumulating like the portfolio does.
router.post('/profile-photo/upload', requireAuth, (req, res) => {
  upload.single('photo')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: uploadErrorMessage(err, 12) });
    if (!req.file) return res.status(400).json({ error: 'No photo file was provided' });

    if (!fs.existsSync(req.file.path)) {
      console.error(`Profile photo upload reported success but file is missing at ${req.file.path} — check that UPLOADS_DIR points to a writable, persistent location.`);
      return res.status(500).json({ error: 'The photo could not be saved to disk. Please try again, or contact support if this keeps happening.' });
    }

    if (!verifyImageMagicBytes(req.file.path, req.file.mimetype)) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'This file does not appear to be a genuine image — please upload a real photo.' });
    }

    const user = await db.find('users', u => u.id === req.user.sub);
    const oldFilename = user && user.profilePhotoUrl ? user.profilePhotoUrl.split('/').pop() : null;

    const updated = await db.update('users', req.user.sub, { profilePhotoUrl: `/uploads/${req.file.filename}` });
    if (!updated || updated.profilePhotoUrl !== `/uploads/${req.file.filename}`) {
      fs.unlink(req.file.path, () => {});
      console.error(`Profile photo did not persist for user ${req.user.sub}.`);
      return res.status(500).json({ error: 'The photo could not be saved. Please try again.' });
    }

    // Clean up the previous photo now that the new one is confirmed saved.
    if (oldFilename) {
      fs.unlink(path.join(UPLOADS_DIR, oldFilename), () => {});
    }

    res.status(201).json({ profilePhotoUrl: updated.profilePhotoUrl });
  });
});

// DELETE /api/profile-photo — remove the current profile photo, reverting
// to the initials avatar everywhere it's shown.
router.delete('/profile-photo', requireAuth, async (req, res) => {
  const user = await db.find('users', u => u.id === req.user.sub);
  if (!user || !user.profilePhotoUrl) return res.status(404).json({ error: 'No profile photo to remove' });
  const filename = user.profilePhotoUrl.split('/').pop();
  await db.update('users', req.user.sub, { profilePhotoUrl: null });
  fs.unlink(path.join(UPLOADS_DIR, filename), () => {});
  res.json({ ok: true });
});

module.exports = router;
